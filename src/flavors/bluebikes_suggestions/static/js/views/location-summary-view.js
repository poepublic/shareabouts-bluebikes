/*globals Backbone _ jQuery Handlebars */

var Shareabouts = Shareabouts || {};

(function(S, $, console){
  // Override the PlaceFormView to include a LocationSummaryView as a child.
  const PlaceFormView__initialize = S.PlaceFormView.prototype.initialize;
  S.PlaceFormView.prototype.initialize = function() {
    PlaceFormView__initialize.call(this, arguments);
  }

  S.PlaceFormView.prototype.assignJurisdiction = async function() {
    if (!this.ll) return;

    const point = turf.point([this.ll.lng, this.ll.lat]);
    if (!await Bluebikes.pointIsInServiceArea(point)) return;

    const jurisdiction = await Bluebikes.findCity(point);
    if (jurisdiction) {
      this.model.set('jurisdiction', jurisdiction);
      this.$('[name=jurisdiction]').val(jurisdiction);
    }
  };

  const PlaceFormView__setLatLng = S.PlaceFormView.prototype.setLatLng;
  S.PlaceFormView.prototype.setLatLng = function(ll) {
    PlaceFormView__setLatLng.call(this, ll);

    // Update the jurisdiction based on the new location.
    this.assignJurisdiction();

    // Trigger a custom event to update the location summary view.
    // $(S).trigger('requestlocationsummary', [ll]);
    if (this.locationSummaryView) {
      this.locationSummaryView.ll = ll;
      this.locationSummaryView.render();
    }
  }

  function makeSummaryData(ll, location, collection) {
    const lat = ll.lat;
    const lng = ll.lng;
    const radius = S.Config.map.proximity_radius || 50; // Default to 50 meters
    const point = turf.point([lng, lat]);
    const addressOrPlace = location || '...';

    // Get the suggestions within the radius of the point.
    const suggestions = collection.models.filter(suggestion => {
      const geom = suggestion.get('geometry');
      if (!geom) return false;
      const suggestionPoint = turf.point(geom.coordinates);
      return turf.distance(point, suggestionPoint, {units: 'meters'}) <= radius * 2;
    });

    // Separate suggestions into those made by the current user and others.
    const yourSuggestions = suggestions.filter(suggestion => suggestion.get('user_token') === S.Config.userToken);
    const othersSuggestions = suggestions.filter(suggestion => suggestion.get('user_token') !== S.Config.userToken);

    // Count the reasons for each suggestion.
    // This is used to display the most common reasons for suggestions.
    // The reasons are expected to be an array of strings in the suggestion attributes.
    // If no reasons are provided, it defaults to an empty array.
    const suggestionCounts = suggestions.reduce((counts, suggestion) => {
      let reasons = suggestion.get('good_location_reasons') || [];
      if (!Array.isArray(reasons)) {
        reasons = [reasons]; // Ensure it's an array, not a single string value.
      }
      for (const reason of reasons) {
        counts[reason] = counts[reason] || 0;
        counts[reason]++;
      }
      return counts;
    }, {});

    const reasonOptions = S.Config.place.items.find(item => item.name === 'good_location_reasons').options;
    const suggestionReasons = Object.entries(suggestionCounts)
      .sort((a, b) => b[1] - a[1])  // <- Sort by count, descending
      .map(([reasonCode, count]) => {
        const reason = reasonOptions.find(option => option.value === reasonCode);
        return {
          code: reasonCode,
          label: reason?.label || reasonCode,
          color: reason?.color || null, // Default to null if no color is specified
          count,
          percentage: 1.0 * count / suggestions.length
        };
      });

    // Find the closest Bluebikes station to the point.
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

    return {
      ll, lat, lng,
      addressOrPlace,
      radius,
      youSuggested: yourSuggestions.length > 0,
      othersSuggestionCount: othersSuggestions.length,
      suggestionReasons,
      closestStation,
      closestStationName,
      closestStationDistance,
      closestStationReadableDistance,
    };
  }

  const PlaceFormView__getTemplateData = S.PlaceFormView.prototype.getTemplateData;
  S.PlaceFormView.prototype.getTemplateData = function() {
    const placeFormData = {
      ...PlaceFormView__getTemplateData.call(this, arguments),
      location_type: 'suggestion',
    };
    
    if (!this.ll) return placeFormData;

    const summaryData = makeSummaryData(this.ll, this.location, this.collection);

    return {
      ...placeFormData,
      ...summaryData,
    };
  }

  const PlaceFormView__render = S.PlaceFormView.prototype.render;
  S.PlaceFormView.prototype.render = function() {
    PlaceFormView__render.call(this, arguments);

    const locationSummaryEl = this.$('.location-summary-container');
    this.locationSummaryView = new S.LocationSummaryView({
      parent: this,
      collection: this.model.collection,
      el: locationSummaryEl,
      options: this.options,
    });

    // Render the location summary view after the place form view is rendered.
    // this.locationSummaryView.render();
    return this;
  }

  S.LocationSummaryView = Backbone.View.extend({
    initialize: function() {
      this.ll = null;
      this.updateFormVisibility(null, null, null)

      this.collection.on('add', this.onChange, this);
      this.collection.on('remove', this.onChange, this);
      this.collection.on('reset', this.onChange, this);

      Bluebikes.events.addEventListener('stationsLoaded', this.render.bind(this));
      $(S).on('locationidentify', (event, data) => {
        this.addressOrPlace = data.place_name.replace(/Massachusetts \d{5}, United States/, 'MA') || '(unable to locate place)';
        this.render();
      });

      $(S).on('requestlocationsummary', (evt, ll) => {
        // If the ll is different (within a tolerance of 5 decimal places),
        // update the view.
        if (!this.ll || Math.abs(this.ll.lat - ll.lat) > 0.00001 || Math.abs(this.ll.lng - ll.lng) > 0.00001) {
          this.ll = ll;
          this.addressOrPlace = null; // Reset address/place to force reverse geocoding
          this.render();
        }
      });
    },

    updateFormVisibility: async function(youSuggested, stationDistance, stationDistanceThreshold) {
      const parent = this.options.parent;

      // If the user has already suggested a location, hide the form.
      const form = parent.el.querySelector('[data-hide-when-you-suggested]');
      if (form && youSuggested) {
        form.classList.add('hidden');
      }
      
      // If the user has not suggested a location, show the form.
      else if (form && !youSuggested) {
        form.classList.remove('hidden');
      }

      this.requiredHiddenFields = this.requiredHiddenFields || new Set();
      const fields = parent.el.querySelectorAll('[data-show-when-close-to-station]')

      // If the station is within the threshold distance, show the fields,
      // restoring any that were previously required.
      if (stationDistance && stationDistance <= stationDistanceThreshold) {
        for (const field of fields) {
          const fieldContainer = field.closest('.field');
          fieldContainer.classList.remove('hidden');

          if (this.requiredHiddenFields.has(field)) {
            field.setAttribute('required', 'required');
            this.requiredHiddenFields.delete(field);
          }
        }
      }
      
      // If the station is not within the threshold distance, hide the fields,
      // remembering which ones were required.
      else {
        for (const field of fields) {
          const fieldContainer = field.closest('.field');
          fieldContainer.classList.add('hidden');

          if (field.hasAttribute('required')) {
            this.requiredHiddenFields.add(field);
            field.removeAttribute('required');
          }
        }
      }

      // Finally, check if the point is within the Bluebikes service area.
      // If it is not, hide the form and show a dialog.
      if (this.ll) {
        const point = turf.point([this.ll.lng, this.ll.lat]);
        const inServiceArea = await Bluebikes.pointIsInServiceArea(point);
        if (form && !inServiceArea) {
          form.classList.add('hidden');
        }
      }
    },
    render: _.throttle(function() {
      if (S.mode !== 'summarize' && S.mode !== 'suggest') {
        return this;
      }

      // console.log('Rendering location summary view with options:', this.options);
      
      if (this.ll) {
        const data = makeSummaryData(
          this.ll,
          this.addressOrPlace, 
          this.collection,
        );

        const youSuggested = data.youSuggested;
        const stationDistance = data.closestStationDistance;
        const stationDistanceThreshold = data.radius;
        this.updateFormVisibility(youSuggested, stationDistance, stationDistanceThreshold);

        const html = Handlebars.templates['location-summary'](data);
        this.$el.html(html);

        // Draw a chart of the suggestion reasons if available.
        if (data.suggestionReasons && data.suggestionReasons.length > 0) {
          const chart = c3.generate({
            data: {
              columns: data.suggestionReasons.map(reason => [reason.label, reason.percentage]),
              colors: data.suggestionReasons.reduce((acc, reason) => ({...acc, [reason.label]: reason.color}), {}),
              type: 'pie',
            },
            size: {
              height: 160,
            },
            pie: {
              label: {
                show: false,
              },
            },
            legend: {
              position: 'right'
            },
          });

          this.$('.suggestion-reasons-chart').html(chart.element);
        }
      }

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
