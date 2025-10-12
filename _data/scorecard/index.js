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
    fetch("https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/doc/ghcnh-station-list.txt", {
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
  // Process each line (no header lines to skip in GHCNh format)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length >= 90) { // Basic check for a valid data line
      const ghcnId = line.substring(0, 11).trim();
      const countryCode = ghcnId.substring(0, 2);
      const networkCode = ghcnId.substring(2, 3);
      const stationId = ghcnId.substring(3);
      
      let state = line.substring(38, 40).trim();
      const latitude = parseFloat(line.substring(12, 20));
      const longitude = parseFloat(line.substring(21, 30));

      // We only want US stations
      if (countryCode === 'US' && !isNaN(latitude) && !isNaN(longitude)) {
        let name = line.substring(41, 71).trim();
        const elevation = parseFloat(line.substring(31, 37));
        const gsnFlag = line.substring(72, 75).trim();
        const hcnCrnFlag = line.substring(76, 79).trim();
        const wmoId = line.substring(80, 85).trim();
        const icao = line.substring(86, 90).trim();
        
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
            id: ghcnId,
            ghcn_id: ghcnId,
            country_code: countryCode,
            network_code: networkCode,
            station_id: stationId,
            name,
            state_abbr: state,
            state_name: stateAbbrToName[state] || state,
            latitude,
            longitude,
            elev: isNaN(elevation) ? null : elevation,
            gsn_flag: gsnFlag,
            hcn_crn_flag: hcnCrnFlag,
            wmo_id: wmoId,
            icao: icao,
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