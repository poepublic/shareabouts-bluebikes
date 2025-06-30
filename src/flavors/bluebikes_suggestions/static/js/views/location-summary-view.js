/*globals Backbone _ jQuery Handlebars */

var Shareabouts = Shareabouts || {};

(function(S, $, console){
  S.LocationSummaryView = Backbone.View.extend({
    initialize: function() {
      this.lat = this.options.lat;
      this.lng = this.options.lng;
      this.zoom = this.options.zoom;
      this.radius = this.options.radius;
      this.isNew = this.options.isNew || false;

      this.collection.on('add', this.onChange, this);
      this.collection.on('remove', this.onChange, this);
      this.collection.on('reset', this.onChange, this);

      Bluebikes.events.addEventListener('stationsLoaded', this.render.bind(this));
      $(S).on('locationidentify', (event, data) => {
        this.addressOrPlace = data.place_name.replace(/Massachusetts \d{5}, United States/, 'MA') || '(unable to locate place)';
        this.render();
      });

      $(S).on('requestlocationsummary', (evt, ll, zoom, radius, isNew) => {
        // If the ll is different (within a tolerance of 5 decimal places),
        // update the view.
        if (Math.abs(this.lat - ll.lat) > 0.00001 || Math.abs(this.lng - ll.lng) > 0.00001) {
          this.lat = ll.lat;
          this.lng = ll.lng;
          this.addressOrPlace = null; // Reset address/place to force reverse geocoding
        }

        this.zoom = zoom || this.zoom;
        this.radius = radius || this.radius;;
        this.isNew = isNew || false;
        this.render();
      });
    },

    render: _.throttle(function() {
      if (S.mode !== 'summarize') {
        return this;
      }

      // console.log('Rendering location summary view with options:', this.options);
      const lat = this.lat;
      const lng = this.lng;
      const zoom = this.zoom;
      const radius = this.radius;
      const isNew = this.isNew;
      const point = turf.point([lng, lat]);
      const buffered = turf.buffer(point, radius, {units: 'meters'});
      const addressOrPlace = this.addressOrPlace || '...';

      const suggestions = this.collection.models.filter(suggestion => {
        const geom = suggestion.get('geometry');
        if (!geom) return false;
        const suggestionPoint = turf.point(geom.coordinates);
        return turf.distance(point, suggestionPoint, {units: 'meters'}) <= radius * 2;
      });
      const yourSuggestions = suggestions.filter(suggestion => suggestion.get('user_token') === S.Config.userToken);
      const othersSuggestions = suggestions.filter(suggestion => suggestion.get('user_token') !== S.Config.userToken);
      const suggestionCounts = suggestions.reduce((counts, suggestion) => {
        for (const reason of suggestion.attributes.reasons || []) {
          counts[reason] = counts[reason] || 0;
          counts[reason]++;
        }
        return counts;
      }, {});
      const suggestionReasons = Object.entries(suggestionCounts)
        .sort((a, b) => a[1] - b[1])
        .map(([reasonCode, count]) => {
          const reason = reasonCode;
          return [reasonCode, reason, count, 1.0 * count / suggestions.length];
        })

      const stationDistanceCache = {};
      const closestStation = Bluebikes.stations.features?.sort((a, b) => {
        if (!stationDistanceCache[a.id]) {
          stationDistanceCache[a.id] = turf.distance(point, turf.point(a.geometry.coordinates), {units: 'meters'});
        }
        if (!stationDistanceCache[b.id]) {
          stationDistanceCache[b.id] = turf.distance(point, turf.point(b.geometry.coordinates), {units: 'meters'});
        }
        return stationDistanceCache[a.id] - stationDistanceCache[b.id];
      })[0];
      const closestStationName = closestStation ? closestStation.properties.Name : null;
      const closestStationDistance = closestStation ? stationDistanceCache[closestStation.id] : null;
      const closestStationReadableDistance = closestStation ? S.Util.humanizeDistance(closestStationDistance) : null;

      const data = _.extend({
        isNew,
        lat, lng,
        addressOrPlace,
        radius,
        youSuggested: yourSuggestions.length > 0,
        othersSuggestionCount: othersSuggestions.length,
        closestStation,
        closestStationName,
        closestStationDistance,
        closestStationReadableDistance,
      });

      const html = Handlebars.templates['location-summary'](data);
      this.$el.html(html);

      // console.log('Rendered location summary view with data:', data, html);

      return this;
    }, 1000),

    remove: function() {
      this.model.off('change', this.onChange);
      this.$el.off('click', '.share-link a');
    },

    onChange: function() {
      this.render();
    },

    onToggleVisibility: function(evt) {
      var $button = this.$(evt.target);
      $button.attr('disabled', 'disabled');

      this.model.save({visible: !this.model.get('visible')}, {
        beforeSend: function($xhr) {
          $xhr.setRequestHeader('X-Shareabouts-Silent', 'true');
        },
        success: function() {
          S.Util.log('USER', 'updated-place-visibility', 'successfully-edit-place');
        },
        error: function() {
          S.Util.log('USER', 'updated-place-visibility', 'fail-to-edit-place');
        },
        complete: function() {
          $button.removeAttr('disabled');
        },
        wait: true
      });
    }
  });
}(Shareabouts, jQuery, Shareabouts.Util.console));
