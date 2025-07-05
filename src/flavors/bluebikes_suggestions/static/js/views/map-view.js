/*globals L Backbone _ */

var Shareabouts = Shareabouts || {};

(function(S, $, console){
  S.MapView = Backbone.View.extend({
    events: {
      'click .locate-me': 'onClickGeolocate'
    },
    initialize: function() {
      var self = this.
          i, layerModel,
          logUserZoom = () => {
            const bounds = this.map.getBounds();
            const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
            S.Util.log('USER', 'map', 'zoom', `[${bbox}]`, this.map.getZoom());
          },
          logUserPan = (evt) => {
            const bounds = this.map.getBounds();
            const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
            S.Util.log('USER', 'map', 'drag', `[${bbox}]`, this.map.getZoom());
          };
      
      const config = this.options.mapConfig;

      // Init the map
      mapboxgl.accessToken = config.mapbox_access_token || S.bootstrapped.mapboxToken;

      this.map = new mapboxgl.Map({
        container: "map", // container id
        attributionControl: false, // disable default attribution
        ...config.options, // map options from the config
      });

      this.searchBox = document.getElementById('place-search-box');
      this.searchBox.bindMap(this.map);

      this.isInitialMapLoadDone = false;

      this.whenMapLoaded().then(() => {
        this.makeProximityLayer();
        this.makeExistingStationsLayer();
        this.makeStationSuggestionsLayer();
      });

      // Customize attribution control
      this.map.addControl(new mapboxgl.AttributionControl({
          customAttribution: ''
        }));

      // Init geolocation
      if (this.options.mapConfig.geolocation_enabled) {
        this.initGeolocation();
      }

      if (this.options.mapConfig.geocoding_enabled) {
        this.initGeocoding();
      }

      // The MapView may be in one of three modes:
      // 1. Browse mode, where the map is just a map displaying the data layers.
      // 2. Summarize mode, where the map is displaying a summary of a location.
      // 3. Suggest mode, where the map is displaying a form to suggest a new location.
      this.mode = this.options.mode || 'browse';

      // Map event logging
      this.map.on('moveend', logUserPan);
      this.map.on('zoomend', logUserZoom);

      this.map.on('moveend', function(evt) {
        $(S).trigger('mapmoveend', [evt]);
        $(S).trigger('mapdragend', [evt]);
      });

      // Bind data events
      this.collection.on('reset', this.syncDataLayers, this);
      this.collection.on('add', this.syncDataLayers, this);
      this.collection.on('remove', this.syncDataLayers, this);
      Bluebikes.events.addEventListener('stationsLoaded', this.syncDataLayers.bind(this));

      // Map interaction events
      this.map.on('click', this.handleLocationSelect.bind(this));
      this.map.on('mousedown', (evt) => { clearTimeout(this.singleClickTimeout) });
      this.map.on('touchstart', (evt) => { clearTimeout(this.singleClickTimeout) });

      this.searchBox.addEventListener('retrieve', this.handleSearchBoxRetrieve.bind(this));

      // Global app events
      $(S).on('appmodechange', this.handleAppModeChange.bind(this));
      $(S).on('requestlocationsummary', this.handleRequestLocationSummary.bind(this));
    },
    handleAppModeChange: function(mode) {
      this.render();
    },
    handleLocationSelect: function(evt) {
      clearTimeout(this.singleClickTimeout);

      this.singleClickTimeout = setTimeout(async () => {
        if (this.doubleclicked) {
          // If the user double-clicked, we don't want to do anything.
          return;
        }

        // Get the click coordinate and zoom level, and navigate to /zoom/lat/lng/suggestions.
        const ll = evt.lngLat;
        const zoom = this.map.getZoom() < 14 ? 14 : this.map.getZoom();
        console.log('clicked on the map at:', ll);

        // Make sure the point is in the service area before proceeding.
        if (!await window.app.enforcePointInServiceArea(ll)) {
          return;
        }

        // Clicking on the map should cause these shifts in mode:
        // - browse -> summarize
        // - summarize -> summarize (re-centering on the clicked point)
        // - suggest -> suggest (updating the proximity layer and map center)
        // In all of these cases, we want to update the proximity layer and
        // reverse geocode the clicked point.
        this.updateProximitySource(ll);
        this.showProximityLayer();
        this.reverseGeocodePoint(ll);

        // Regardless of the mode, we want to center the map on the clicked point.
        this.setView(ll.lng, ll.lat, zoom);

        // Let the rest of the app know that a location has been selected.
        $(S).trigger('locationselect', [ll, zoom]);

        // If the app is in suggest mode, let other components know that the new
        // location should be set.
        if (S.mode === 'suggest') {
          $(S).trigger('suggestionlocationchange', [ll]);
        }
      }, 300);
    },
    handleRequestLocationSummary: function(evt, ll, zoom) {
      // When the app requests a location, we want to center the map on the
      // requested point and zoom level.
      zoom = zoom || Math.max(this.map.getZoom(), this.options.mapConfig.summary_min_zoom);
      this.setView(ll.lng, ll.lat, zoom);

      // Update the proximity layer to reflect the new center point.
      this.updateProximitySource(ll);
      this.showProximityLayer();

      // Reverse geocode the point to get the address or place name.
      this.reverseGeocodePoint(ll);
    },
    handleSearchBoxRetrieve: async function(evt) {
      // When the search box retrieves a location, we want to center the map on
      // the retrieved point and zoom level.
      const selection = evt.detail;  // The detail is a FeatureCollection.
      if (!selection || !selection.features || selection.features.length === 0) {
        console.warn('No features found in search box selection:', selection);
        return;
      }

      const feature = selection.features[0];
      const coords = feature.geometry.coordinates;
      const ll = { lng: coords[0], lat: coords[1] };

      // Make sure the point is in the service area before proceeding.
      if (!await window.app.enforcePointInServiceArea(ll)) {
        return;
      }

      // Update and show the proximity layer based on the search result.
      this.updateProximitySource(ll);
      this.showProximityLayer();

      // Reverse geocode the point to get the address or place name.
      this.reverseGeocodePoint(ll);

      // Let the rest of the app know that a location has been selected.
      $(S).trigger('locationselect', [ll, 14]);

      // If the app is in suggest mode, let other components know that the new
      // location should be set.
      if (S.mode === 'suggest') {
        $(S).trigger('suggestionlocationchange', [ll]);
      }
    },
    reverseGeocodePoint: _.throttle(function(point) {
      var geocodingEngine = this.options.mapConfig.geocoding_engine || 'MapQuest';

      S.Util[geocodingEngine].reverseGeocode(point, {
        success: function(data) {
          var locationData = S.Util[geocodingEngine].getLocation(data);
          // S.Util.console.log('Reverse geocoded center: ', data);
          $(S).trigger('locationidentify', [locationData]);
        }
      });
    }, 1000),
    reverseGeocodeMapCenter: function() {
      const ll = this.map.getCenter();
      this.reverseGeocodePoint(ll);
    },
    whenMapLoaded: function() {
      return new Promise((resolve) => {
        if (this.isInitialMapLoadDone) {
          resolve();
        } else {
          this.map.on('load', () => {
            this.isInitialMapLoadDone = true;
            resolve();
          });
        }
      });
    },
    syncDataLayers: _.throttle(function() {
      // Sync data to the station layers if the data are loaded.
      const startTime = new Date();
      this.updateExistingStations();
      this.updateStationSuggestions();

      const endTime = new Date();
      console.log(`Updated layers with ${this.collection.models.length} suggestions; took ${endTime - startTime}ms to create layer; finished at ${endTime.toLocaleTimeString()}`);
    }, 500),
    updateExistingStations: function() {
      const existingStationsSource = this.map.getSource('existing-stations');
      if (!existingStationsSource) {
        console.warn('No existing stations source found, cannot update existing stations.');
        return;
      }

      const data = Bluebikes.stations;
      existingStationsSource.setData(data);
    },
    updateStationSuggestions: function() {
      const suggestionsSource = this.map.getSource('station-suggestions');
      if (!suggestionsSource) {
        console.warn('No station suggestions source found, cannot update station suggestions.');
        return;
      }

      const radius = this.options.mapConfig.proximity_radius;
      if (!radius) {
        console.warn('No proximity radius defined, cannot update station suggestions.');
        return;
      }

      const models = this.collection.models;

      // Calculating the halo circles around each suggestion takes a non-trivial
      // amount of time, so cache the halos for each suggestion as we construct
      // them.
      this.suggestionHaloCache = this.suggestionHaloCache || {};
      const suggestionHaloFeatureCollection = {
        type: 'FeatureCollection',
        features: models.filter(model => !!model.get('geometry')).map(model => {
          let halo = this.suggestionHaloCache[model.id];
          if (!halo) {
            const properties = model.toJSON();
            const center = turf.point(model.get('geometry').coordinates, properties);
            halo = turf.circle(center, radius, { units: 'meters', properties });
            this.suggestionHaloCache[model.id] = halo;
          }
          return halo;
        }),
      };
      suggestionsSource.setData(suggestionHaloFeatureCollection);
    },
    makeExistingStationsLayer: function() {
      if (!this.map.getSource('existing-stations')) {
        this.map.addSource('existing-stations', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.map.hasImage('bluebikes-station-icon')) {
        const img = document.getElementById('bluebikes-station-icon');
        this.map.addImage('bluebikes-station-icon', img, { pixelRatio: 1 });
      }

      if (!this.map.getLayer('existing-stations-dot-layer')) {
        this.map.addLayer({
          'id': 'existing-stations-dot-layer',
          'type': 'circle',
          'source': 'existing-stations',
          'maxzoom': 13,
          'paint': {
            'circle-color': '#2ca3e1',
            'circle-radius': ['interpolate',
              ['linear'],
              ['zoom'],
              9, 1,
              13, 4,
            ],
            'circle-opacity': ['interpolate',
              ['linear'],
              ['zoom'],
              12, 1,
              13, 0,
            ],
          },
          'layout': {},
        });
      }

      if (!this.map.getLayer('existing-stations-icon-layer')) {
        this.map.addLayer({
          'id': 'existing-stations-icon-layer',
          'type': 'symbol',
          'source': 'existing-stations',
          'minzoom': 12,
          'layout': {
            'icon-anchor': 'center',
            'icon-image': 'bluebikes-station-icon',
            'icon-size': ['interpolate',
              ['linear'],
              ['zoom'],
              13, 0.125,
              15, 0.25,
            ],  // The image is 64x64, so this scales it 8x8 up to 16x16.
            'icon-allow-overlap': true,
            'text-field': ['get', 'name'],
            'text-anchor': 'top',
            'text-offset': [0, 0.5],
            'text-size': ['interpolate',
              ['linear'],
              ['zoom'],
              12, 9,
              18, 12,
            ],
          },
          'paint': {
            'text-color': '#0d4877',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1,
            'text-halo-blur': 1,
          },
        }, 'existing-stations-dot-layer');
      }
    },
    makeStationSuggestionsLayer: function() {
      if (!this.map.getSource('station-suggestions')) {
        this.map.addSource('station-suggestions', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.map.getLayer('station-suggestions-layer')) {
        // this.map.addLayer({
        //   'id': 'station-suggestions-layer',
        //   'type': 'heatmap',
        //   'source': 'station-suggestions',
        //   'layout': {},
        //   'paint': {
        //     'heatmap-color': [
        //       "interpolate", 
        //       ["linear"], 
        //       ["heatmap-density"],
        //       0, "rgba(241, 93, 34, 0)",
        //       1, "rgba(241, 93, 34, 1)"
        //     ],
        //     'heatmap-radius': 10,
        //   },
        // }, 'proximity-layer');
        this.map.addLayer(
          {
            'id': 'station-suggestions-layer',
            'type': 'fill',
            'source': 'station-suggestions',
            'layout': {},
            'paint': {
              'fill-color': "#e16a2c",  // <-- Complement of the bluebikes color
              'fill-opacity': 0.1,
            },
          },

          // Add the layer directly under the proximity layer
          'proximity-layer',
        );
      }
    },
    getProximityData: function(ll) {
      if (!ll) {
        return {
          type: 'FeatureCollection',
          features: []
        };
      }

      const point = turf.point([ll.lng, ll.lat]);
      const radius = this.options.mapConfig.proximity_radius;
      const ring = turf.circle(point, radius, { units: 'meters' });
      
      const proximityData = {
        type: 'FeatureCollection',
        features: [ ring, ]
      };

      const closestStation = Bluebikes.closestStation(point);
      if (closestStation) {
        const distance = turf.distance(point, turf.point(closestStation.geometry.coordinates), { units: 'meters' });
        proximityData.features.push(
          turf.lineString(
            [point.geometry.coordinates, closestStation.geometry.coordinates],
            {
              stationId: closestStation.id,
              stationName: closestStation.properties.name,
              distance: S.Util.humanizeDistance(distance)
            },
          )
        );
      }

      console.log('Proximity data generated:', proximityData);
      return proximityData;
    },
    makeProximityLayer: function() {
      if (!this.map.getSource('proximity')) {
        this.map.addSource('proximity', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.map.getLayer('proximity-layer')) {
        this.map.addLayer({
          'id': 'proximity-layer',
          'type': 'line',
          'source': 'proximity',
          // 'slot': 'top',
          'layout': {},
          'paint': {
            'line-dasharray': [2, 2],
            'line-width': 2,
            'line-opacity': 0.55,
            'line-color': '#000',
          }
        });
      }
    },
    updateProximitySource: function(ll) {
      const proximitySource = this.map.getSource('proximity');
      if (!proximitySource) {
        console.warn('No proximity source found, cannot update proximity data.');
        return;
      }
      proximitySource.setData(this.getProximityData(ll));
    },
    showProximityLayer: function(setToCenter = false) {
      const hasProximityLayer = !!this.map.getLayer('proximity-layer');
      if (!hasProximityLayer) {
        console.warn('No proximity layer found, cannot hide proximity layer.');
        return;
      }

      // If the layer is not visible, update the source too.
      const isVisible = this.map.getLayoutProperty('proximity-layer', 'visibility') === 'visible';
      if (setToCenter && !isVisible) {
        const center = this.map.getCenter();
        this.updateProximitySource(center);
      }
      this.map.setLayoutProperty('proximity-layer', 'visibility', 'visible');
    },
    hideProximityLayer: function() {
      const hasProximityLayer = !!this.map.getLayer('proximity-layer');
      if (!hasProximityLayer) {
        console.warn('No proximity layer found, cannot hide proximity layer.');
        return;
      }
      this.map.setLayoutProperty('proximity-layer', 'visibility', 'none');
    },
    render: function() {
      // Clear any existing stuff on the map, and free any views in
      // the list of layer views.
      this.whenMapLoaded().then(() => {
        this.syncDataLayers();

        if (S.mode === 'suggest' || S.mode === 'summarize') {
          // If we're in suggest mode, we need to show the proximity layer.
          this.showProximityLayer();
        } else {
          // Otherwise, hide the proximity layer.
          this.hideProximityLayer();
        }
      });
    },
    updateSize: function() {
      // this.map.invalidateSize({ animate:true, pan:true });
      this.map.resize();
    },
    initGeolocation: function() {
      var self = this;

      var onLocationError = function(evt) {
        var message;
        switch (evt.code) {
          // Unknown
          case 0:
            message = 'An unknown error occured while locating your position. Please try again.';
            break;
          // Permission Denied
          case 1:
            message = 'Geolocation is disabled for this page. Please adjust your browser settings.';
            break;
          // Position Unavailable
          case 2:
            message = 'Your location could not be determined. Please try again.';
            break;
          // Timeout
          case 3:
            message = 'It took too long to determine your location. Please try again.';
            break;
        }
        alert(message);
      };

      var onLocationFound = function(evt) {
        var msg;
        if(!self.map.options.maxBounds ||self.map.options.maxBounds.contains(evt.latlng)) {
          self.map.fitBounds(evt.bounds);
        } else {
          msg = 'It looks like you\'re not in a place where we\'re collecting ' +
            'data. I\'m going to leave the map where it is, okay?';
          alert(msg);
        }
      };

      // Add the geolocation control link
      this.$('.leaflet-top.leaflet-right').append(
        '<div class="leaflet-control leaflet-bar">' +
          '<a href="#" class="locate-me" role="button" title="Center on my location" aria-label="Center on my location"></a>' +
        '</div>'
      );

      // Bind event handling
      this.map.on('locationerror', onLocationError);
      this.map.on('locationfound', onLocationFound);

      // Go to the current location if specified
      if (this.options.mapConfig.geolocation_onload) {
        this.geolocate();
      }
    },
    getCenter: function() {
      return this.map.getCenter();
    },
    getZoom: function() {
      return this.map.getZoom();
    },
    initGeocoding: function() {
      // var geocoder;
      // var control;
      // var options = {
      //     collapsed: false,
      //     position: 'topright',
      //     defaultMarkGeocode: false,
      //     geocoder: geocoder
      //   };

      // switch (this.options.mapConfig.geocoding_engine) {
      //   case 'Mapbox':
      //     options.geocoder = L.Control.Geocoder.mapbox(S.bootstrapped.mapboxToken, {
      //       geocodingQueryParams: {
      //         proximity: [
      //           this.options.mapConfig.options.center.lng,
      //           this.options.mapConfig.options.center.lat
      //         ].join(',')
      //       }
      //     });
      //     break;

      //   default:
      //     options.geocoder = L.Control.Geocoder.mapQuest(S.bootstrapped.mapQuestKey);
      //     break;
      // }

      // if (this.options.mapConfig.geocode_field_label) {
      //   options.placeholder = this.options.mapConfig.geocode_field_label
      // }

      // control = L.Control.geocoder(options)
      //   .on('markgeocode', function(evt) {
      //     result = evt.geocode || evt;
      //     const zoom = this._map.getBoundsZoom(result.bbox);
      //     const center = result.center;
      //     this._map.setView(center, zoom);
      //     $(S).trigger('geocode', [evt]);
      //   })
      //   .addTo(this.map);

      // // Move the control to the center
      // $('<div class="leaflet-top leaflet-center"/>')
      //   .insertAfter($('.leaflet-top.leaflet-left'))
      //   .append($(control._container))

      // Shareabouts.geocoderControl = control;
    },
    onClickGeolocate: function(evt) {
      evt.preventDefault();
      S.Util.log('USER', 'map', 'geolocate', this.map.getBounds().toBBoxString(), this.map.getZoom());
      this.geolocate();
    },
    geolocate: function() {
      this.map.locate();
    },
    addLayerView: function(model) {
      this.layerViews[model.cid] = new S.LayerView({
        model: model,
        router: this.options.router,
        map: this.map,
        placeLayers: this.placeLayers,
        placeTypes: this.options.placeTypes,
        mapView: this
      });
    },
    removeLayerView: function(model) {
      this.layerViews[model.cid].remove();
      delete this.layerViews[model.cid];
    },
    zoomInOn: function(latLng) {
      this.map.setView(latLng, this.options.mapConfig.options.maxZoom || 17);
    },
    setView: function(lng, lat, zoom) {
      const center = this.map.getCenter();

      // If the map is already centered on the point, within 5 decimal places of
      // tolerance, do nothing.
      if (Math.abs(center.lng - lng) < 0.00001 && Math.abs(center.lat - lat) < 0.00001) {
        return;
      }

      this.map.easeTo({
        center: [lng, lat],
        zoom: zoom || this.map.getZoom()
      });
    },

    filter: function(locationType) {
      var self = this;
      console.log('filter the map', arguments);
      this.locationTypeFilter = locationType;
      this.collection.each(function(model) {
        var modelLocationType = model.get('location_type');

        if (modelLocationType &&
            modelLocationType.toUpperCase() === locationType.toUpperCase()) {
          self.layerViews[model.cid].show();
        } else {
          self.layerViews[model.cid].hide();
        }
      });
    },

    clearFilter: function() {
      this.locationTypeFilter = null;
      this.render();
    }
  });

})(Shareabouts, jQuery, Shareabouts.Util.console);
