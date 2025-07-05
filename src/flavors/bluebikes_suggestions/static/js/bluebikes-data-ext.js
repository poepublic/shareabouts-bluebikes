var Bluebikes = Bluebikes || {};
Bluebikes.events = Bluebikes.events || new EventTarget();

Bluebikes.stationsUrl = 'https://gbfs.lyft.com/gbfs/1.1/bos/en/station_information.json';
Bluebikes.stations = [];

Bluebikes.serviceAreaUrl = `${Shareabouts.Config.dataPath}/bluebikes_service_area.geojson`;
Bluebikes.serviceArea = null;

function gbfsToFeatureCollection(info) {
  return {
    type: 'FeatureCollection',
    features: info.data.stations.map(station => ({
      type: 'Feature',
      id: station.station_id,
      properties: {...station}, // Includes `name`
      geometry: {
        type: 'Point',
        coordinates: [station.lon, station.lat]
      }
    }))
  };
}

Bluebikes.fetchStations = async (retries = 3) => {
  try {
    const response = await fetch(Bluebikes.stationsUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const gbfs = await response.json();
    Bluebikes.stations = gbfsToFeatureCollection(gbfs);
    Bluebikes.events.dispatchEvent(new Event('stationsLoaded'));
  } catch (error) {
    console.error('Error fetching Bluebikes stations:', error);
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      return Bluebikes.fetchStations(retries - 1);
    } else {
      console.error('Failed to fetch Bluebikes stations after multiple attempts.');
      Bluebikes.events.dispatchEvent(new Event('stationsError'));
    }
  }
}

Bluebikes.fetchServiceArea = async (retries = 3) => {
  try {
    const response = await fetch(Bluebikes.serviceAreaUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const serviceArea = await response.json();
    Bluebikes.serviceArea = serviceArea;
    Bluebikes.events.dispatchEvent(new Event('serviceAreaLoaded'));
  } catch (error) {
    console.error('Error fetching Bluebikes service area:', error);
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      return Bluebikes.fetchServiceArea(retries - 1);
    } else {
      console.error('Failed to fetch Bluebikes service area after multiple attempts.');
      Bluebikes.events.dispatchEvent(new Event('serviceAreaError'));
    }
  }
}

Bluebikes.waitForServiceArea = () => {
  return new Promise((resolve, reject) => {
    // If the service area has already been loaded, resolve immediately
    if (Bluebikes.serviceArea) {
      resolve(Bluebikes.serviceArea);
      return;
    }

    // Otherwise, set up an event listener to resolve when the service area is loaded
    const onServiceAreaLoaded = () => {
      removeListeners();
      resolve(Bluebikes.serviceArea);
    };
    
    const onServiceAreaError = () => {
      removeListeners();
      reject(new Error('Failed to load Bluebikes service area.'));
    };

    const removeListeners = () => {
      Bluebikes.events.removeEventListener('serviceAreaLoaded', onServiceAreaLoaded);
      Bluebikes.events.removeEventListener('serviceAreaError', onServiceAreaError);
    }

    Bluebikes.events.addEventListener('serviceAreaError', onServiceAreaError);
    Bluebikes.events.addEventListener('serviceAreaLoaded', onServiceAreaLoaded);
  });
}

Bluebikes.pointIsInServiceArea = async (point) => {
  const serviceArea = await Bluebikes.waitForServiceArea();

  // Get the Combined_Service_Area feature
  const serviceAreaFeature = serviceArea.features.find(feature => feature.properties.boundary_name === 'Combined_Service_Area');
  if (!serviceAreaFeature) {
    throw new Error('Combined_Service_Area feature not found.');
  }

  // Check if the point is within the service area polygon
  return turf.booleanPointInPolygon(point, serviceAreaFeature);
}

Bluebikes.findCity = async (point) => {
  const serviceArea = await Bluebikes.waitForServiceArea();

  // Check whether there's a city boundary that contains the point
  for (const feature of serviceArea.features) {
    if (feature.properties.boundary_name !== 'Combined_Service_Area' && turf.booleanPointInPolygon(point, feature)) {
      return feature.properties.boundary_name;
    }
  }

  // If not, return the closest city boundary
  const cityDistances = serviceArea.features
    .filter(feature => feature.properties.boundary_name !== 'Combined_Service_Area')
    .map(feature => {
      const cityPoint = turf.centroid(feature);
      const distance = turf.pointToPolygonDistance(point, feature, { units: 'meters' });
      return { feature, distance };
    });

  const closestCity = cityDistances.reduce((min, current) => {
    return current.distance < min.distance ? current : min;
  });

  return closestCity.feature.properties.boundary_name;
}

const closestStationCache = {};
Bluebikes.closestStation = (point) => {
  if (!Bluebikes.stations || !Bluebikes.stations.features) {
    return null;
  }

  const coordsStr = point.geometry.coordinates.map(coord => coord.toFixed(6)).join(',');
  if (closestStationCache[coordsStr]) {
    return closestStationCache[coordsStr];
  }
  
  const stationDistances = Bluebikes.stations.features.map(station => {
    const stationPoint = turf.point(station.geometry.coordinates);
    const distance = turf.distance(point, stationPoint, { units: 'meters' });
    return { station, distance };
  });

  const closest = stationDistances.reduce((min, current) => {
    return current.distance < min.distance ? current : min;
  });

  closestStationCache[coordsStr] = closest.station;

  return closest.station;
}

Bluebikes.fetchStations();
Bluebikes.fetchServiceArea();
