var Bluebikes = Bluebikes || {};

Bluebikes.stationsUrl = 'https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/Blue_Bike_Stations/FeatureServer/0/query?outFields=*&where=1%3D1&f=geojson';
Bluebikes.stations = [];
Bluebikes.events = Bluebikes.events || new EventTarget();

Bluebikes.fetchStations = async (retries = 3) => {
  try {
    const response = await fetch(Bluebikes.stationsUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    Bluebikes.stations = data;
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

Bluebikes.closestStation = (point) => {
  if (!Bluebikes.stations || !Bluebikes.stations.features) {
    return null;
  }
  
  const stationDistances = Bluebikes.stations.features.map(station => {
    const stationPoint = turf.point(station.geometry.coordinates);
    const distance = turf.distance(point, stationPoint, { units: 'meters' });
    return { station, distance };
  });

  const closest = stationDistances.reduce((min, current) => {
    return current.distance < min.distance ? current : min;
  });

  return closest.station;
}

Bluebikes.fetchStations();
