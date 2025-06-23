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

      // Deck.gl data overlay
      this.dataOverlay = new deck.MapboxOverlay({
        interleaved: true,
      });

      this.syncDataLayers();

      this.map.once('load', () => {
        this.map.addControl(this.dataOverlay);
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
    ifWhenMapLoaded: function(callback) {
      if (this.map.loaded()) {
        callback();
      } else {
        this.map.on('load', callback);
      }
    },
    syncDataLayers: _.throttle(function() {
      if (this.dataOverlay === null) { 
        console.log('Data overlay not initialized yet, skipping syncDataLayers');
        return;
      }

      // Sync data to the station layers if the data are loaded.
      const stationsLayer = this.makeStationLayer();
      const suggestionsLayer = this.makeSuggestionLayer();

      const startTime = new Date();
      this.dataOverlay.setProps({
        layers: [suggestionsLayer, stationsLayer]
      });
      const endTime = new Date();
      console.log(`Updated layers with ${this.collection.models.length} suggestions; took ${endTime - startTime}ms to create layer; finished at ${endTime.toLocaleTimeString()}`);
    }, 2000),
    makeStationLayer: function() {
      const data = Bluebikes.stations;
      const layer = new deck.ScatterplotLayer({
        id: 'existing-stations',
        data: data.features,
        getPosition: s => s.geometry.coordinates,
        getFillColor: () => [8, 137, 203, 255],
        getRadius: () => 3,
        radiusUnits: 'pixels',
      });
      return layer;
    },
    makeSuggestionLayer: function() {
      const data = this.collection.models;
      let fillcount = 0;
      const layer = new deck.ScatterplotLayer({
        id: 'station-suggestions',
        data: data,
        getPosition: (inst) => {
          return inst.get('geometry').coordinates
        },
        getFillColor: () => [241, 93, 34, 25],
        getRadius: () => this.options.mapConfig.proximity_radius
      });
      return layer;
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
    updateProximitySource: function(lng, lat) {
      const proximitySource = this.map.getSource('proximity');
      if (proximitySource) {
        proximitySource.setData(this.getProximityData(lng, lat));
      } else {
        this.makeProximitySource(lng, lat);
      }
    },
    makeProximitySource: function(lng, lat) {
      this.ifWhenMapLoaded(() => {
        this.map.addSource('proximity', {
          type: 'geojson',
          data: this.getProximityData(lng, lat),
        });
      });
    },
    showProximityLayer: function(lng, lat) {
      this.ifWhenMapLoaded(() => {
        this.updateProximitySource(lng, lat);
  
        if (!this.map.getLayer('proximity-layer')) {
          this.map.addLayer({
            'id': 'proximity-layer',
            'type': 'line',
            'source': 'proximity',
            'layout': {},
            'paint': {
              'line-dasharray': [2, 2],
              'line-width': 2,
              'line-opacity': 0.5,
              'line-color': '#000',
            }
          });
        }
      });
    },
    hideProximityLayer: function() {
      if (this.map.getLayer('proximity-layer')) {
        this.map.removeLayer('proximity-layer');
      }
    },
    render: function() {
      // Clear any existing stuff on the map, and free any views in
      // the list of layer views.
      this.syncDataLayers();
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
