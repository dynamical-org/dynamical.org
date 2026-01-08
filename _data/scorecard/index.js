const fetch = require("@11ty/eleventy-fetch");

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
  const csvText = await fetch("https://sa.dynamical.org/stations.csv", {
    duration: "1d", // Cache for 1 day
    type: "text",
  });

  const stations = [];
  const lines = csvText.split('\n');
  
  // Process rows (skip header if present)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const columns = line.split(',');

      // Header guard (works for either source list)
      if (i === 0 && columns[0] && /station/i.test(columns[0])) {
        continue;
      }
      
      if (columns.length >= 11) {
        // Supported CSV formats:
        // - GHCNh-ish: station_id,STATION NAME,latitude,longitude,elevation,ST,wmoId,icao,gsnFlag,hcnCrnFlag,CTRY,...
        // - ASOS-ish:  station_id,STATION NAME,longitude,latitude,elevation,ST,CTRY,begin,end,begin,end,ST,...
        const stationId = columns[0].trim();
        const name = columns[1].trim();

        const a = parseFloat(columns[2]); // could be lat or lon
        const b = parseFloat(columns[3]); // could be lon or lat

        // Auto-detect lat/lon column order (ASOS list uses lon,lat).
        let latitude = a;
        let longitude = b;
        if (!isNaN(a) && !isNaN(b)) {
          // Strong heuristic for US stations:
          // - longitude is usually negative (west), latitude positive (north)
          if (a < 0 && b > 0) {
            longitude = a;
            latitude = b;
          } else if (a > 0 && b < 0) {
            latitude = a;
            longitude = b;
          } else {
          const aLooksLikeLat = Math.abs(a) <= 90;
          const bLooksLikeLat = Math.abs(b) <= 90;
          const aLooksLikeLon = Math.abs(a) <= 180;
          const bLooksLikeLon = Math.abs(b) <= 180;

          if (!aLooksLikeLat && bLooksLikeLat && aLooksLikeLon) {
            // lon,lat
            longitude = a;
            latitude = b;
          } else if (aLooksLikeLat && !bLooksLikeLat && bLooksLikeLon) {
            // lat,lon (default)
            latitude = a;
            longitude = b;
          }
          }
        }

        const elevation = parseFloat(columns[4]);
        const state = columns[5].trim();

        const isAsos = columns[6] && columns[6].trim() === "US";

        // Handle Aleutians / dateline wrap so Alaska stations project correctly.
        // Some feeds report AK longitudes in [0, 180]E; D3's US projections expect [-180, 0]W.
        if (state === "AK" && !isNaN(longitude) && longitude > 0) {
          longitude = longitude - 360;
        }

        // Country code is at different indices depending on source CSV.
        let countryCode = "";
        if (columns[6] && columns[6].trim() === "US") {
          countryCode = "US";
        } else if (columns[10] && columns[10].trim() === "US") {
          countryCode = "US";
        } else {
          countryCode = (columns[10] && columns[10].trim()) || (columns[6] && columns[6].trim()) || "";
        }

        // Optional metadata (present in GHCNh-ish list, not ASOS-ish list)
        const wmoId = (!isAsos && columns[6]) ? columns[6].trim() : "";
        const icao = (!isAsos && columns[7]) ? columns[7].trim() : "";
        const gsnFlag = (!isAsos && columns[8]) ? columns[8].trim() : "";
        const hcnCrnFlag = (!isAsos && columns[9]) ? columns[9].trim() : "";
        
        if (countryCode === 'US' && !isNaN(latitude) && !isNaN(longitude) && state) {
          // Extract network and station components from station ID (format: USXXXXXXXX)
          
          const station = {
            id: stationId,
            country_code: countryCode,
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