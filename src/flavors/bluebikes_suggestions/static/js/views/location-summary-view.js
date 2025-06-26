/*globals Backbone _ jQuery Handlebars */

var Shareabouts = Shareabouts || {};

(function(S, $, console){
  S.LocationSummaryView = Backbone.View.extend({
    initialize: function() {
      this.collection.on('add', this.onChange, this);
      this.collection.on('remove', this.onChange, this);
      this.collection.on('reset', this.onChange, this);

      Bluebikes.events.addEventListener('stationsLoaded', this.render.bind(this));
      $(S).on('reversegeocode', (event, data) => {
        this.addressOrPlace = data.place_name.replace(/Massachusetts \d{5}, United States/, 'MA') || '(unable to locate place)';
        this.render();
      });
    },

    render: _.throttle(function() {
      // console.log('Rendering location summary view with options:', this.options);
      const lat = this.options.lat;
      const lng = this.options.lng;
      const zoom = this.options.zoom;
      const radius = this.options.radius;
      const isNew = this.options.isNew;
      const point = turf.point([lng, lat]);
      const buffered = turf.buffer(point, radius, {units: 'meters'});
      const addressOrPlace = this.addressOrPlace || '...';

      const suggestions = this.collection.models.filter(suggestion => {
        const suggestionPoint = turf.point(suggestion.get('geometry').coordinates);
        return turf.distance(point, suggestionPoint, {units: 'meters'}) <= radius * 2;
        // return turf.booleanPointInPolygon(suggestionPoint, buffered);
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
