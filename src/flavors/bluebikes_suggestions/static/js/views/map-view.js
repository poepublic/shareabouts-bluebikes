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
      this.map.on('click', this.handleMapClick.bind(this));
    },
    handleMapClick: function(evt) {
      // Get the click coordinate and zoom level, and navigate to /zoom/lat/lng/summary.
      const center = evt.lngLat;
      const zoom = this.map.getZoom();
      console.log('clicked on the map at:', center);
      this.options.router.navigate(`/${zoom}/${center.lat}/${center.lng}/summary`, {trigger: true});
    },
    reverseGeocodeMapCenter: _.debounce(function() {
      var center = this.map.getCenter();
      var geocodingEngine = this.options.mapConfig.geocoding_engine || 'MapQuest';

      S.Util[geocodingEngine].reverseGeocode(center, {
        success: function(data) {
          var locationData = S.Util[geocodingEngine].getLocation(data);
          // S.Util.console.log('Reverse geocoded center: ', data);
          $(S).trigger('reversegeocode', [locationData]);
        }
      });
    }, 1000),
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
      const data = {
        type: 'FeatureCollection',
        features: models.map(model => {
          const properties = model.toJSON();
          const center = turf.point(model.get('geometry').coordinates, properties);
          const circle = turf.circle(center, radius, { units: 'meters', properties });
          return circle;
        }),
      };
      suggestionsSource.setData(data);
    },
    makeExistingStationsLayer: function() {
      if (!this.map.getSource('existing-stations')) {
        this.map.addSource('existing-stations', {
          type: 'geojson',
          data: null,
        });
      }

      if (!this.map.getLayer('existing-stations-layer')) {
        this.map.addLayer({
          'id': 'existing-stations-layer',
          'type': 'circle',
          'source': 'existing-stations',
          'layout': {},
          'paint': {
            'circle-radius': 3,
            'circle-color': "rgba(8, 137, 203, 1)",
          },
        });
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
        this.map.addLayer({
          'id': 'station-suggestions-layer',
          'type': 'fill',
          'source': 'station-suggestions',
          'layout': {},
          'paint': {
            'fill-color': "rgb(241, 93, 34)",
            'fill-opacity': 0.1,
          },
        }, 'proximity-layer');
      }
    },
    getProximityData: function(lng, lat) {
      const point = turf.point([lng, lat]);
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
    updateProximitySource: function(lng, lat) {
      const proximitySource = this.map.getSource('proximity');
      if (!proximitySource) {
        console.warn('No proximity source found, cannot update proximity data.');
        return;
      }
      proximitySource.setData(this.getProximityData(lng, lat));
    },
    hideProximityLayer: function() {
      const proximitySource = this.map.getSource('proximity');
      if (!proximitySource) {
        console.warn('No proximity source found, cannot hide proximity layer.');
        return;
      }
      proximitySource.setData(null);
    },
    render: function() {
      // Clear any existing stuff on the map, and free any views in
      // the list of layer views.
      this.whenMapLoaded().then(() => {
        this.syncDataLayers();
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
      // this.map.setView([lat, lng], zoom || this.map.getZoom());
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
