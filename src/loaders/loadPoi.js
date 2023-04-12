import { loadGoogleSpreadSheet } from '../utils/loadSpreadSheet';
import { PLACEMENT_MAP_SHEET } from '../constants';
import L from 'leaflet';

const iconsSize = 48;
const iconAnchor = iconsSize * 0.5;

var centeredIcon = L.Icon.extend({
    options: {
        iconSize: [iconsSize, iconsSize],
        iconAnchor: [iconAnchor, iconAnchor],
        popupAnchor: [0, -iconsSize * 0.25],
    },
});

export const loadPoi = async () => {
    const spreadsheetdata = await loadGoogleSpreadSheet(PLACEMENT_MAP_SHEET, 'poi!A2:F');
    let iconDict = {};

    let poiLayer = L.layerGroup();

    for (let i = 0; i < spreadsheetdata.length; i++) {
        if (spreadsheetdata[i][0]) {
            //Check if 'type' column is not empty
            const [type, name, description, lonlat] = spreadsheetdata[i];
            const [lon, lat] = lonlat.split(',');

            if (!iconDict[type]) iconDict[type] = new centeredIcon({ iconUrl: './img/icons/' + type + '.png' });

            let navigatehere = ' ';
            navigatehere += '<a';
            navigatehere += ' href="';
            navigatehere += 'https://tim.gremalm.se/gps/updategps.php?lat=';
            navigatehere += lon;
            navigatehere += '&lng=';
            navigatehere += lat;
            navigatehere += '"';
            navigatehere += ' target="_blank"';
            navigatehere += '>';
            navigatehere += '☩';
            navigatehere += '</a>';

            const content = '<h3>' + name + '</h3>' + '<p>' + description + navigatehere + '</p>';
            L.marker([lon, lat], { icon: iconDict[type] }).addTo(poiLayer).bindPopup(content);
        }
    }

    return poiLayer;
};
