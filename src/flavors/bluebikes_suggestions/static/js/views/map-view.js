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
            const bounds = this.baseMap.getBounds();
            const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
            S.Util.log('USER', 'map', 'zoom', `[${bbox}]`, this.baseMap.getZoom());
          },
          logUserPan = (evt) => {
            const bounds = this.baseMap.getBounds();
            const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
            S.Util.log('USER', 'map', 'drag', `[${bbox}]`, this.baseMap.getZoom());
          };
      
      const config = this.options.mapConfig;
      const baseOptions = config.options || {};
      const overlayOptions = {...baseOptions};
      delete overlayOptions.style; // Don't inherit the style from the base map.

      // Init the map
      mapboxgl.accessToken = config.mapbox_access_token || S.bootstrapped.mapboxToken;

      this.baseMap = new mapboxgl.Map({
        container: "map", // container id
        attributionControl: false, // disable default attribution
        ...config.options, // map options from the config
      });
      this.map = this.baseMap; // For compatibility with existing code that uses `this.map`

      this.suggestionsMap = new mapboxgl.Map({
        container: "suggestions-overlay",
        style: { "version": 8, "sources": {}, "layers": [], glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf" },
        ...overlayOptions,
      });

      this.stationsMap = new mapboxgl.Map({
        container: "stations-overlay",
        style: { "version": 8, "sources": {}, "layers": [], glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf" },
        ...overlayOptions,
      });

      syncMaps(this.baseMap, this.suggestionsMap, this.stationsMap);

      this.searchBox = document.getElementById('place-search-box');
      this.searchBox.bindMap(this.baseMap);

      this.isInitialMapLoadDone = false;

      this.whenMapLoaded().then(() => {
        this.makeProximityLayer();
        this.makeExistingStationsLayer();
        this.makeStationSuggestionsLayer();
      });

      // Customize attribution control
      this.baseMap.addControl(new mapboxgl.AttributionControl({
          customAttribution: ''
        }));

      // Init geolocation
      if (this.options.mapConfig.geolocation_enabled) {
        this.initGeolocation();
      }

      if (this.options.mapConfig.geocoding_enabled) {
        this.initGeocoding();
      }

      // Map event logging
      this.baseMap.on('moveend', logUserPan);
      this.baseMap.on('zoomend', logUserZoom);

      this.baseMap.on('moveend', function(evt) {
        $(S).trigger('mapmoveend', [evt]);
        $(S).trigger('mapdragend', [evt]);
      });

      // Bind data events
      this.collection.on('reset', this.syncDataLayers, this);
      this.collection.on('add', this.syncDataLayers, this);
      this.collection.on('remove', this.syncDataLayers, this);
      Bluebikes.events.addEventListener('stationsLoaded', this.syncDataLayers.bind(this));

      // Map interaction events
      this.baseMap.on('click', this.handleLocationSelect.bind(this));
      this.baseMap.on('mousedown', (evt) => { clearTimeout(this.singleClickTimeout) });
      this.baseMap.on('touchstart', (evt) => { clearTimeout(this.singleClickTimeout) });

      this.searchBox.addEventListener('retrieve', this.handleSearchBoxRetrieve.bind(this));

      // Global app events
      $(S).on('requestlocationsummary', this.handleRequestLocationSummary.bind(this));
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
        const zoom = this.baseMap.getZoom() < 14 ? 14 : this.baseMap.getZoom();
        console.log('clicked on the map at:', ll);

        this.selectLocation(ll, zoom);
      }, 300);
    },
    handleRequestLocationSummary: function(evt, ll, zoom) {
      // When the app requests a location, we want to center the map on the
      // requested point and zoom level.
      zoom = zoom || Math.max(this.baseMap.getZoom(), this.options.mapConfig.summary_min_zoom);
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

      // Let other components know that the new location should be set.
      $(S).trigger('suggestionlocationchange', [ll]);
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
      const ll = this.baseMap.getCenter();
      this.reverseGeocodePoint(ll);
    },
    whenMapLoaded: function() {
      return new Promise((resolve) => {
        if (this.isInitialMapLoadDone) {
          resolve();
        } else {
          this.baseMap.on('load', () => {
            this.isInitialMapLoadDone = true;
            resolve();
          });
        }
      });
    },
    selectLocation: async function(ll, zoom) {
      console.log(ll);

      // Make sure the point is in the service area before proceeding.
      if (!await window.app.enforcePointInServiceArea(ll)) {
        return;
      }

      // Update the proximity layer and reverse geocode the clicked point.
      this.updateProximitySource(ll);
      this.showProximityLayer();
      this.reverseGeocodePoint(ll);

      // We want to center the map on the clicked point.
      this.setView(ll.lng, ll.lat, zoom);

      // Let the rest of the app know that a location has been selected.
      $(S).trigger('locationselect', [ll, zoom]);

      // Let other components know that the new location should be set.
      $(S).trigger('suggestionlocationchange', [ll]);
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
      const existingStationsSource = this.baseMap.getSource('existing-stations');
      if (!existingStationsSource) {
        console.warn('No existing stations source found, cannot update existing stations.');
        return;
      }

      const data = Bluebikes.stations;
      existingStationsSource.setData(data);
    },
    updateStationSuggestions: function() {
      const suggestionsSource = this.suggestionsMap.getSource('station-suggestions');
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
        features: models.filter(model => !model.isNew() && !!model.get('geometry')).map(model => {
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
      if (!this.stationsMap.getSource('existing-stations')) {
        // There are some capabilities in Mapbox GL JS that require a unique
        // _numeric_ ID for each feature. The GBFS data provides a unique
        // `station_id` for each station, but we need to ensure that the `id`
        // field in the source is numeric. So, in this case, instead of using
        // the `station_id` as the ID, we will rely on the `generateId`
        // attribute on the map source.
        this.stationsMap.addSource('existing-stations', {
          type: 'geojson',
          data: null,
          generateId: true,  // Ensure each feature has a unique numeric ID.
        });
      }

      if (!this.stationsMap.hasImage('bluebikes-station-icon')) {
        const img = document.getElementById('bluebikes-station-icon');
        this.stationsMap.addImage('bluebikes-station-icon', img, { pixelRatio: 1 });
      }

      if (!this.stationsMap.getLayer('existing-stations-dot-layer')) {
        this.stationsMap.addLayer({
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

      // if (!this.stationsMap.getLayer('existing-stations-icon-layer')) {
      //   this.stationsMap.addLayer({
      //     'id': 'existing-stations-icon-layer',
      //     'type': 'symbol',
      //     'source': 'existing-stations',
      //     'minzoom': 12,
      //     'layout': {
      //       'icon-anchor': 'center',
      //       'icon-image': 'bluebikes-station-icon',
      //       'icon-size': ['interpolate',
      //         ['linear'],
      //         ['zoom'],
      //         13, 0.125,
      //         15, 0.25,
      //       ],  // The image is 64x64, so this scales it 8x8 up to 16x16.
      //       'icon-allow-overlap': true,
      //       'text-field': ['get', 'name'],
      //       'text-anchor': 'top',
      //       'text-offset': [0, 0.5],
      //       'text-optional': true,
      //       'text-size': ['interpolate',
      //         ['linear'],
      //         ['zoom'],
      //         12, 9,
      //         18, 12,
      //       ],
      //     },
      //     'paint': {
      //       'text-color': '#0d4877',
      //       'text-halo-color': '#ffffff',
      //       'text-halo-width': 1,
      //       'text-halo-blur': 1,
      //       'text-opacity': ['interpolate',
      //         ['linear'],
      //         ['zoom'],
      //         13, 0,
      //         14, 1,
      //       ],
      //       // 'text-opacity': ['case',
      //       //   ['boolean', ['feature-state', 'hovered'], false],
      //       //   1,
      //       //   0,
      //       // ],
      //     },
      //   }, 'existing-stations-dot-layer');

      //   // ====================================================================
      //   // NOTE: We're not using the hovers right now. Instead, we're trying to
      //   // use label overlaps smartly. I keep it here in case it's useful as a
      //   // reference in the future.

      //   let hoveredStationId = null;

      //   const unhoverStation = () => {
      //     if (hoveredStationId) {
      //       this.stationsMap.setFeatureState(
      //         { source: 'existing-stations', id: hoveredStationId },
      //         { hovered: false }
      //       );
      //       hoveredStationId = null;
      //     }
      //   };

      //   const hoverStation = (stationId) => {
      //     if (hoveredStationId !== stationId) {
      //       unhoverStation();
      //       hoveredStationId = stationId;
      //       this.stationsMap.setFeatureState(
      //         { source: 'existing-stations', id: stationId },
      //         { hovered: true }
      //       );
      //     }
      //   };
        
      //   this.stationsMap.on('mouseenter', 'existing-stations-icon-layer', (e) => {
      //     // Set the station feature state to hovered
      //     if (e.features && e.features.length > 0) {
      //       const stationId = e.features[0].id;
      //       if (!stationId) {
      //         console.warn('No station ID found in feature:', e.features[0].properties);
      //         return;
      //       }
      //       hoverStation(stationId);
      //     }
      //   });

      //   this.stationsMap.on('mouseleave', 'existing-stations-icon-layer', () => {
      //     // Reset the station feature state on mouse leave
      //     unhoverStation();
      //   });
      // }
    },
    makeStationSuggestionsLayer: function() {
      if (!this.suggestionsMap.getSource('station-suggestions')) {
        this.suggestionsMap.addSource('station-suggestions', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.suggestionsMap.getLayer('station-suggestions-layer')) {
        // this.suggestionsMap.addLayer({
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
        this.suggestionsMap.addLayer(
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

          // // Add the layer directly under the proximity layer
          // 'proximity-layer',
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
      if (!this.stationsMap.getSource('proximity')) {
        this.stationsMap.addSource('proximity', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.stationsMap.getLayer('proximity-layer')) {
        this.stationsMap.addLayer({
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
      const proximitySource = this.stationsMap.getSource('proximity');
      if (!proximitySource) {
        console.warn('No proximity source found, cannot update proximity data.');
        return;
      }
      proximitySource.setData(this.getProximityData(ll));
    },
    showProximityLayer: function(setToCenter = false) {
      const hasProximityLayer = !!this.stationsMap.getLayer('proximity-layer');
      if (!hasProximityLayer) {
        console.warn('No proximity layer found, cannot hide proximity layer.');
        return;
      }

      // If the layer is not visible, update the source too.
      const isVisible = this.stationsMap.getLayoutProperty('proximity-layer', 'visibility') === 'visible';
      if (setToCenter && !isVisible) {
        const center = this.stationsMap.getCenter();
        this.updateProximitySource(center);
      }
      this.stationsMap.setLayoutProperty('proximity-layer', 'visibility', 'visible');
    },
    hideProximityLayer: function() {
      const hasProximityLayer = !!this.stationsMap.getLayer('proximity-layer');
      if (!hasProximityLayer) {
        console.warn('No proximity layer found, cannot hide proximity layer.');
        return;
      }
      this.stationsMap.setLayoutProperty('proximity-layer', 'visibility', 'none');
    },
    render: function() {
      // Clear any existing stuff on the map, and free any views in
      // the list of layer views.
      this.whenMapLoaded().then(() => {
        this.syncDataLayers();

        if (this.options.router.appView.isAddingPlace()) {
          // If we're suggesting, we need to show the proximity layer.
          this.showProximityLayer();
        } else {
          // Otherwise, hide the proximity layer.
          this.hideProximityLayer();
        }
      });
    },
    updateSize: function() {
      // this.baseMap.invalidateSize({ animate:true, pan:true });
      this.baseMap.resize();
      this.suggestionsMap.resize();
      this.stationsMap.resize();
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
      document.getElementById('geolocation-button').addEventListener('click', this.onClickGeolocate.bind(this));

      // Bind event handling
      this.baseMap.on('locationerror', onLocationError);
      this.baseMap.on('locationfound', onLocationFound);

      // Go to the current location if specified
      if (this.options.mapConfig.geolocation_onload) {
        this.geolocate();
      }
    },
    getCenter: function() {
      return this.baseMap.getCenter();
    },
    getZoom: function() {
      return this.baseMap.getZoom();
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
      //   .addTo(this.baseMap);

      // // Move the control to the center
      // $('<div class="leaflet-top leaflet-center"/>')
      //   .insertAfter($('.leaflet-top.leaflet-left'))
      //   .append($(control._container))

      // Shareabouts.geocoderControl = control;
    },
    onClickGeolocate: function(evt) {
      evt.preventDefault();
      S.Util.log('USER', 'map', 'geolocate');
      this.geolocate();
    },
    geolocate: function() {
      navigator.geolocation.getCurrentPosition((position) => {
        const ll = {
          lng: position.coords.longitude,
          lat: position.coords.latitude
        };
        this.selectLocation(ll, this.baseMap.getZoom());
      }, (error) => {
        console.error('Geolocation error:', error);
        alert('Could not determine your location. Please try again.');
      });
    },
    addLayerView: function(model) {
      this.layerViews[model.cid] = new S.LayerView({
        model: model,
        router: this.options.router,
        map: this.baseMap,
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
      this.baseMap.setView(latLng, this.options.mapConfig.options.maxZoom || 17);
    },
    setView: function(lng, lat, zoom) {
      const center = this.baseMap.getCenter();

      // If the map is already centered on the point, within 5 decimal places of
      // tolerance, do nothing.
      if (Math.abs(center.lng - lng) < 0.00001 && Math.abs(center.lat - lat) < 0.00001) {
        return;
      }

      this.baseMap.easeTo({
        center: [lng, lat],
        zoom: zoom || this.baseMap.getZoom()
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
