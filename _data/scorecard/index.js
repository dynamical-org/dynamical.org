const fetch = require("@11ty/eleventy-fetch");
const turf = require("@turf/turf");
const topojson = require("topojson-client");

const stateAbbrToName = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "AS": "American Samoa", "DC": "District of Columbia", "FM": "Federated States of Micronesia",
    "GU": "Guam", "MH": "Marshall Islands", "MP": "Northern Mariana Islands", "PW": "Palau",
    "PR": "Puerto Rico", "VI": "Virgin Islands"
};

async function getStations() {
  const [text, us] = await Promise.all([
    fetch("https://www.ncei.noaa.gov/pub/data/noaa/isd-history.txt", {
      duration: "1d", // Cache for 1 day
      type: "text",
    }),
    fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json", {
      duration: "1d",
      type: "json"
    })
  ]);

  const statesGeoJson = topojson.feature(us, us.objects.states);
  const stateFeatures = statesGeoJson.features;

  const stations = [];
  const lines = text.split('\n');
  // Skip header lines
  for (let i = 22; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 90) { // Basic check for a valid data line
      const country = line.substring(43, 45).trim();
      const usaf = line.substring(0, 6).trim();
      const wban = line.substring(7, 12).trim();
      const end = line.substring(91, 99).trim();
      let state = line.substring(48, 50).trim();
      const latitude = parseFloat(line.substring(55, 63));
      const longitude = parseFloat(line.substring(64, 73));

      // We only want active US stations
      if (country === 'US' && usaf !== '999999' && end >= '20250601') {
        let name = line.substring(13, 42).trim();
        
        if (!state) {
          const potentialState = name.slice(-2);
          if (stateAbbrToName[potentialState]) {
            state = potentialState;
            name = name.slice(0, -2).trim();
          }
        } else if (name.endsWith(` ${state}`)) {
          name = name.slice(0, -3).trim();
        }

        if (!state && latitude && longitude) {
          const point = turf.point([longitude, latitude]);
          for (const stateFeature of stateFeatures) {
            if (turf.booleanPointInPolygon(point, stateFeature)) {
              const stateName = stateFeature.properties.name;
              for (const abbr in stateAbbrToName) {
                if (stateAbbrToName[abbr] === stateName) {
                  state = abbr;
                  break;
                }
              }
              break;
            }
          }
        }

        if (state) {
          const station = {
            id: `${usaf}-${wban}`,
            country,
            usaf,
            wban, 
            name,
            state_abbr: state,
            state_name: stateAbbrToName[state] || state,
            latitude,
            longitude,
            elev: parseFloat(line.substring(74, 81)),
            begin: line.substring(82, 90).trim(),
            end: end,
          };
          stations.push(station);
        }
      }
    }
  }
  return stations;
}

module.exports = async function() {
  const stations = await getStations();
  const states = Object.values(stations.reduce((acc, s) => {
    if (s.state_name && !acc[s.state_name]) {
      acc[s.state_name] = { name: s.state_name, abbr: s.state_abbr };
    }
    return acc;
  }, {}));

  return {
    stations,
    states,
  };
};