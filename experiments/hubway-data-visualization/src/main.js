import './style.css';

// Leaflet
import 'leaflet/dist/leaflet.css';
import 'leaflet/dist/leaflet.js';

// Mapbox GL within Leaflet
import 'mapbox-gl/dist/mapbox-gl.css';
import 'mapbox-gl/dist/mapbox-gl.js';
import 'mapbox-gl-leaflet/leaflet-mapbox-gl.js';

// Leaflet Marker Cluster
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster/dist/leaflet.markercluster.js';

// Turf.js
import * as turf from "@turf/turf";

document.querySelector('#app').innerHTML = `
  <main>
    <div class="map" id="map"></div>
  </main>
`;

const bostonlat = 42.3601;
const bostonlng = -71.0589;
const map = L.map('map', {maxZoom: 22, minZoom: 8, zoomSnap: 0.5, preferCanvas: true}).setView([bostonlat, bostonlng], 12);

const mapboxStyleURL = 'mapbox://styles/poepublic/cmazesav9006l01sef8i66d1e?access_token={accessToken}';
const mapboxAccessToken = 'pk.eyJ1IjoicG9lcHVibGljIiwiYSI6ImNpaDZnYXNxZDBiajlzd20yd2ZwZXhkb3QifQ.XYIHS6tfEXqoiyximdmLXg';
const gl = L.mapboxGL({
  style: mapboxStyleURL,
  accessToken: mapboxAccessToken,
}).addTo(map);

const aggregationStyleControl = L.control({ position: 'topright' });
aggregationStyleControl.onAdd = function (map) {
  const div = L.DomUtil.create('div', 'info');
  div.innerHTML = `
    <h4>Aggregation Style</h4>
    <select id="aggregation-style">
      <option value="none">None</option>
      <option value="heatmap">Hex</option>
      <option value="cluster">Cluster</option>
    </select>
  `;
  return div;
};
aggregationStyleControl.addTo(map);

const stationsURL = '/data/stations.geojson';
const stationsData = await fetch(stationsURL)
  .then((response) => response.json())
  .catch((error) => {
    console.error('Error fetching stations data:', error);
  });
const stationPane = map.createPane('stationPane');
stationPane.style.zIndex = 601;
const stationsLayer = L.geoJSON(stationsData, {
  pane: 'stationPane',
  pointToLayer: (feature, latlng) => {
    const icon = L.icon({
      iconUrl: '/public/bluebikes-marker.png',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    const marker = L.marker(latlng, { icon });
    return marker;
  }
});
stationsLayer.bindTooltip(l => l.feature.properties.Name)
stationsLayer.addTo(map);

const hubwayDataURL = '/data/hubway.geojson';
const hubwayData = await fetch(hubwayDataURL)
  .then((response) => response.json())
  .catch((error) => {
    console.error('Error fetching Hubway data:', error);
  });

const systemBoundaryURL = '/data/boundary.geojson';
const systemBoundary = await fetch(systemBoundaryURL)
  .then((response) => response.json())
  .catch((error) => {
    console.error('Error fetching system boundary data:', error);
  });

const dataLayers = {};
const dataColor = '#eea211';

// CONFIGURE THE UNAGGREGATED LAYER
dataLayers.noAgg = L.layerGroup([
  // Dots...
  L.geoJSON(hubwayData, {
    pointToLayer: (feature, latlng) => {
      /* Circle Marker... */
      const circleMaker = L.circleMarker(latlng, {
        radius: 2,
        fillColor: dataColor,
        // color: '#000',
        // weight: 1,
        // opacity: 1,
        stroke: false,
        fillOpacity: 0.5,
      });
      return circleMaker;

      /* Fuzzy Icons... */
      // const icon = L.icon({
      //   iconUrl: '/public/suggestion-marker-orange.png',
      //   iconSize: [32, 32],
      //   iconAnchor: [16, 16],
      // });
      // const marker = L.marker(latlng, { icon });
      // return marker;
    },
  }),

  // Circles...
  L.geoJSON(hubwayData, {
    pointToLayer: (feature, latlng) => {
      const circle = L.circle(latlng, {
        radius: 50, // meters?
        fillColor: dataColor,
        // color: '#000',
        // weight: 1,
        // opacity: 1,
        stroke: false,
        fillOpacity: 0.1,
      });
      return circle;
    },
  })
]);

// CONFIGURE THE AGGREGATED LAYER
dataLayers.hexAgg = L.geoJSON(null, {
  style: (feature) => {
    const fillOpacity = feature.properties.scale * 0.8 + 0.2;

    return {
      fillColor: dataColor,
      weight: 0,
      opacity: 1,
      fillOpacity,
    };
  }
})
.bindTooltip((layer) => { return `Radius: ${layer.feature.properties.radius}, Count: ${layer.feature.properties.count}, Scale: ${layer.feature.properties.scale}`; })

function updateAggLayer(zoomLevel) {
  console.log(`Creating a new hex grid at zoom level: ${zoomLevel}`);

  const radius = Math.pow(2, 21 - zoomLevel);
  console.log(`Radius for hex grid: ${radius}`);

  const mapBounds = map.getBounds().pad(1);
  const [n, s, e, w] = [mapBounds.getNorth(), mapBounds.getSouth(), mapBounds.getEast(), mapBounds.getWest()];
  const hexGrid = turf.hexGrid(
    [w, s, e, n],
    radius,
    { units: 'meters' }
  );
  console.log(`Hex grid created with ${hexGrid.features.length} hexagons`);

  const hexFeatures = turf.collect(hexGrid, hubwayData, 'id', 'suggestions');
  hexFeatures.features = hexFeatures.features.filter(f => f.properties.suggestions.length > 0);

  hexFeatures.features.forEach((feature) => {
    const count = feature.properties.suggestions.length;
    feature.properties.radius = radius;
    feature.properties.count = count;
  });

  const maxCount = Math.max(...hexFeatures.features.map(f => f.properties.count));
  const minCount = Math.min(...hexFeatures.features.map(f => f.properties.count));

  hexFeatures.features.forEach((feature) => {
    const scaledCount = (feature.properties.count - minCount) / (maxCount - minCount);
    feature.properties.scale = scaledCount;
  });

  dataLayers.hexAgg.clearLayers();
  dataLayers.hexAgg.addData(hexFeatures);
}
map.on('zoomend', () => {
  if (map.hasLayer(dataLayers.hexAgg)) {
    const zoomLevel = map.getZoom();
    updateAggLayer(zoomLevel);
  }
});
updateAggLayer(map.getZoom());

// CONFIGURE THE CLUSTERED LAYER
dataLayers.clustered = L.markerClusterGroup();
dataLayers.clustered.addLayer(
  L.geoJSON(hubwayData, {
    pointToLayer: (feature, latlng) => {
      const circleMaker = L.circleMarker(latlng, {
        radius: 5,
        fillColor: dataColor,
        color: '#000',
        weight: 1,
        opacity: 1,
        fillOpacity: 0.8,
      });
      return circleMaker;
    },
  })
);

function showLayer(name) {
  for (const [key, layer] of Object.entries(dataLayers)) {
    if (key == name && !map.hasLayer(layer)) {
      layer.addTo(map);
    } else if (key != name && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }
}

function syncAggregationStyle() {
  const selectedValue = aggregationStyleSelect.value;
  if (selectedValue === 'none') {
    showLayer('noAgg');
  } else if (selectedValue === 'heatmap') {
    showLayer('hexAgg');
  } else if (selectedValue === 'cluster') {
    showLayer('clustered');
  }
}

const aggregationStyleSelect = document.getElementById('aggregation-style');
aggregationStyleSelect.addEventListener('change', (event) => {
  syncAggregationStyle();
});

syncAggregationStyle();
