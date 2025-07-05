var Bluebikes = Bluebikes || {};

Bluebikes.stationsUrl = 'https://gbfs.lyft.com/gbfs/1.1/bos/en/station_information.json';
Bluebikes.stations = [];
Bluebikes.events = Bluebikes.events || new EventTarget();

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
