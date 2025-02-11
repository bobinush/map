import * as Turf from '@turf/turf';
import type { MapEntity } from './entity';
import { 
    MAX_CLUSTER_SIZE, 
    MAX_POWER_NEED,
    MAX_POINTS_BEFORE_WARNING,
    FIRE_BUFFER_IN_METER
 } from '../../SETTINGS';
import { Geometry } from 'geojson';
import { GeoJSON } from 'leaflet';
import * as L from 'leaflet';
import CheapRuler from 'cheap-ruler';
import { ClusterCache } from './ClusterCache';

const CHEAP_RULER_BUFFER: number = FIRE_BUFFER_IN_METER + 1; // We add a little extra to the buffer, to compensate for usign the approximation method from cheapruler

const ruler = new CheapRuler(57.5, 'meters');
enum Severity {
    None = 0,
    Low = 1,
    Medium = 2,
    High = 3
}

const clusterCache = new ClusterCache(); // instantiate here and use it as a global cache when calculating clusters

export class Rule {
    private _severity: Severity;
    private _triggered: boolean;
    private _callback: (entity: MapEntity) => { triggered: boolean; shortMessage?: string; message?: string };

    public message: string;
    public shortMessage: string;

    public get severity(): Severity {
        return this._triggered ? this._severity : Severity.None;
    }

    public get triggered(): boolean {
        return this._triggered;
    }

    public checkRule(entity: MapEntity) {
        const result = this._callback(entity);
        this._triggered = result.triggered;
        if (result.shortMessage) this.shortMessage = result.shortMessage;
        if (result.message) this.message = result.message;
    }

    constructor(severity: Severity, shortMessage: string, message: string, callback: Rule['_callback']) {
        this._severity = severity;
        this._triggered = false;
        this._callback = callback;

        this.shortMessage = shortMessage;
        this.message = message;
    }
}

/** Utility function to generate a rule generator function to be used with the editor */
export function generateRulesForEditor(groups: any, placementLayers: any): () => Array<Rule> {
    return () => [
        isBiggerThanNeeded(),
        isCalculatedAreaTooBig(),
        hasLargeEnergyNeed(),
        hasMissingFields(),
        // hasManyCoordinates(),
        // isBreakingSoundLimit(
        //     groups.soundguide,
        //     2,
        //     'Making too much noise?',
        //     'Seems like you wanna play louder than your neighbors might expect? Check the sound guider layer!',
        // ),
        isOverlapping(
            placementLayers,
            2,
            'Overlapping other area!',
            'Your area is overlapping someone elses, plz fix <3',
        ),
        isOverlappingOrContained(
            groups.slope,
            1,
            'Slope warning!',
            'Your area is in slopey or uneven terrain, make sure to check the slope map layer to make sure that you know what you are doing :)',
        ),
        isOverlappingOrContained(
            groups.fireroad,
            3,
            'Touching fireroad!',
            'Plz move this area away from the fire road!',
        ),
        isNotInsideBoundaries(
            groups.propertyborder,
            3,
            'Outside border!',
            'You have placed yourself outside our land, please fix that <3',
        ),
        isOverlappingOrContained(
            groups.hiddenforbidden,
            3,
            'Inside forbidden zone!',
            'You are inside a zone that can not be used this year.',
        ),
        isBufferOverlappingRecursive(
            placementLayers,
            3,
            'Too large/close to others!',
            'For fire safety, we need to add a bit of open space (5m2) between these camps (or if not next to any camps, this camp simply to big)',
        ),
        isNotInsideBoundaries(
            groups.area,
            2,
            'Outside placement areas.',
            'You are outside the main placement area (yellow border). Make sure you know what you are doing.',
        ),
        // NOT NEEDED: Better to use the inside bounderies of groups.area
        // isNotInsideBoundaries(
        //     groups.oktocamp,
        //     2,
        //     'Far from a fire road.',
        //     'You are right now more than 50 meters away from a fire road. Make sure you know what you are doing.',
        // ),
        isOverlappingOrContained(
            groups.publicplease,
            1,
            'Close to fire road',
            'You are adjucant to a fire road, please use this space for public offerings and not just for sleeping',
        ),
        isOverlappingOrContained(
            groups.minorroad,
            2,
            'Blocking a path',
            'You are possibly blocking a path for walking around (the black dotted lines). Keep it clean if possible or plan accordingly!',
        ),
        // Special notification when close to sanctuary
        isOverlappingOrContained(
            groups.closetosanctuary,
            1,
            'Close to the  sanctuary',
            'This area is in the viscinity of the sanctuary, please be mindful of what energy your camp is releasing and how it may effect the santuarcy',
        ),
        // Special notification when on the western meadow
        isOverlappingOrContained(
            groups.redsoundzone,
            1,
            'In the western meadow',
            "You're in the western meadow, please be extra careful of keeping the land in good condition and do not put your overnight camp here unless necessary, public dreams are prefered",
        ),
    ];
}

const hasManyCoordinates = () =>
    new Rule(
        1,
        'Many points.',
        'You have added many points to this shape. Bear in mind that you will have to set this shape up in reality as well.',
        (entity) => {
            const geoJson = entity.toGeoJSON();
            //Dont know why I have to use [0] here, but it works
            return { triggered: geoJson.geometry.coordinates[0].length > MAX_POINTS_BEFORE_WARNING };
        },
    );

const hasLargeEnergyNeed = () =>
    new Rule(1, 'Powerful.', 'You need a lot of power, make sure its not a typo.', (entity) => {
        return { triggered: entity.powerNeed > MAX_POWER_NEED };
    });

const hasMissingFields = () =>
    new Rule(
        2,
        'Missing info',
        'Fill in name, description, contact info, power need and sound amplification please.',
        (entity) => {
            return {
                triggered:
                    !entity.name ||
                    !entity.description ||
                    !entity.contactInfo ||
                    entity.powerNeed === -1 ||
                    entity.amplifiedSound === -1,
            };
        },
    );

const isCalculatedAreaTooBig = () =>
    new Rule(
        3,
        'Too many ppl/vehicles!',
        'Calculated area need is bigger than the maximum allowed area size! Make another area to fix this.',
        (entity) => {
            return { triggered: entity.calculatedAreaNeeded > MAX_CLUSTER_SIZE };
        },
    );

const isBiggerThanNeeded = () =>
    new Rule(
        2,
        'Bigger than needed?',
        'Your area is quite big for the amount of people/vehicles and extras you have typed in.',
        (entity) => {
            return {
                triggered: entity.area > calculateReasonableArea(entity.calculatedAreaNeeded),
                message: `Your area is <b>${
                    entity.area - entity.calculatedAreaNeeded
                }m² bigger</b> than the suggested area size. Consider making it smaller.`,
            };
        },
    );

function calculateReasonableArea(calculatedNeed: number): number {
    // Define constants for the power function
    const a = 0.5; // Controls the initial additional area
    const b = -0.2; // Controls the rate of decrease of the additional area

    // Calculate the additional area percentage using a power function
    const additionalArea = a * Math.pow(calculatedNeed, b);

    // Clamp the additional area between 0 and a
    const clampedAdditionalArea = Math.max(0, Math.min(additionalArea, a));

    // Calculate the allowed area
    const allowedArea = Math.min(calculatedNeed * (1 + clampedAdditionalArea), MAX_CLUSTER_SIZE);

    return allowedArea;
}

const isSmallerThanNeeded = () =>
    new Rule(
        1,
        'Too small.',
        'Considering the amount of people, vehicles and extras you have, this area is probably too small.',
        (entity) => {
            let calculatedNeed = entity.calculatedAreaNeeded;
            if (entity.area < calculatedNeed) {
                return {
                    triggered: true,
                    shortMessage: 'Too small.',
                    message: `Considering the amount of people, vehicles and extras you have, this area is probably too small. Consider adding at least ${Math.ceil(
                        calculatedNeed - entity.area,
                    )}m² more.`,
                };
            } else {
                return { triggered: false };
            }
        },
    );

const isOverlapping = (layerGroup: any, severity: Severity, shortMsg: string, message: string) =>
    new Rule(severity, shortMsg, message, (entity) => {
        return { triggered: _isLayerOverlappingOrContained(entity.layer, layerGroup) };
    });

const isOverlappingOrContained = (layerGroup: any, severity: Severity, shortMsg: string, message: string) =>
    new Rule(severity, shortMsg, message, (entity) => {
        let geoJson = entity.toGeoJSON();
        let overlap = false;

        layerGroup.eachLayer((layer) => {
            //@ts-ignore
            let otherGeoJson = layer.toGeoJSON();

            //Loop through all features if it is a feature collection
            if (otherGeoJson.features) {
                for (let i = 0; i < otherGeoJson.features.length; i++) {
                    if (
                        Turf.booleanOverlap(geoJson, otherGeoJson.features[i]) ||
                        Turf.booleanContains(otherGeoJson.features[i], geoJson)
                    ) {
                        overlap = true;
                        return; // Break out of the inner loop
                    }
                }
            } else if (Turf.booleanOverlap(geoJson, otherGeoJson) || Turf.booleanContains(otherGeoJson, geoJson)) {
                overlap = true;
            }

            if (overlap) {
                return; // Break out of the loop once an overlap is found
            }
        });

        return { triggered: overlap };
    });

const isInsideBoundaries = (layerGroup: any, severity: Severity, shortMsg: string, message: string) =>
    checkEntityBoundaries(layerGroup, severity, shortMsg, message, true);

const isNotInsideBoundaries = (layerGroup: any, severity: Severity, shortMsg: string, message: string) =>
    checkEntityBoundaries(layerGroup, severity, shortMsg, message, false);

const checkEntityBoundaries = (
    layerGroup: any,
    severity: Severity,
    shortMsg: string,
    message: string,
    shouldBeInside: boolean,
) =>
    new Rule(severity, shortMsg, message, (entity) => {
        const layers = layerGroup.getLayers();

        for (const layer of layers) {
            let otherGeoJson = layer.toGeoJSON();

            // Loop through all features if it is a feature collection
            if (otherGeoJson.features) {
                for (let i = 0; i < otherGeoJson.features.length; i++) {
                    if (Turf.booleanContains(otherGeoJson.features[i], entity.toGeoJSON())) {
                        return { triggered: shouldBeInside };
                    }
                }
            } else if (Turf.booleanContains(otherGeoJson, entity.toGeoJSON())) {
                return { triggered: shouldBeInside };
            }
        }

        return { triggered: !shouldBeInside };
    });

/** Utility function to calculate the ovelap between a geojson and layergroup */
function _isGeoJsonOverlappingLayergroup(
    geoJson: Turf.helpers.Feature<any, Turf.helpers.Properties> | Turf.helpers.Geometry,
    layerGroup: L.GeoJSON,
): boolean {
    //NOTE: Only checks overlaps, not if its inside or covers completely

    let overlap = false;
    layerGroup.eachLayer((layer) => {
        //@ts-ignore
        let otherGeoJson = layer.toGeoJSON();

        //Loop through all features if it is a feature collection
        if (otherGeoJson.features) {
            for (let i = 0; i < otherGeoJson.features.length; i++) {
                if (Turf.booleanOverlap(geoJson, otherGeoJson.features[i])) {
                    overlap = true;
                    return; // Break out of the inner loop
                }
            }
        } else if (Turf.booleanOverlap(geoJson, otherGeoJson)) {
            overlap = true;
        }

        if (overlap) {
            return; // Break out of the loop once an overlap is found
        }
    });

    return overlap;
}

/** Utility function to calculate the ovelap between a layer and layergroup */
function _isLayerOverlappingOrContained(layer: L.Layer, layerGroup: L.GeoJSON): boolean {
    //NOTE: Only checks overlaps, not if its inside or covers completely
    //@ts-ignore
    let layerGeoJson = layer.toGeoJSON();
    let bBox = getBBoxForCoords(layerGeoJson.features[0].geometry.coordinates[0]);
    //@ts-ignore

    let overlap = false;
    let i = 0;
    layerGroup.eachLayer((otherLayer) => {
        if (overlap) {
            return;
        }
        if (_compareLayers(layer, otherLayer)) {
            return;
        }
        //@ts-ignore
        let otherGeoJson = otherLayer.toGeoJSON();
        //@ts-ignore
        let otherBBox = getBBoxForCoords(otherGeoJson.features[0].geometry.coordinates[0]);
        if (fastIsOverlap(bBox, otherBBox)) {
            // Might overlap
            if (
                Turf.booleanOverlap(layerGeoJson.features[0], otherGeoJson.features[0]) ||
                Turf.booleanContains(layerGeoJson.features[0], otherGeoJson.features[0])
            ) {
                overlap = true;
            }
        }
    });
    return overlap;
}

const isBufferOverlappingRecursive = (
    layerGroup: any,
    severity: Severity,
    shortMsg: string,
    message: string,
) =>
    new Rule(severity, shortMsg, message, (entity) => {
        //@ts-ignore
        const layer = entity.layer._layers[Object.keys(entity.layer._layers)[0]];

        // invalidate cache if coords have changed
        //@ts-ignore
        clusterCache.coordsHaveChanged(layer._leaflet_id, layer._latlngs[0]) &&
            clusterCache.invalidateCache(entity.layer._leaflet_id);
        const checkedOverlappingLayers = new Set<string>();
        let totalArea = _getTotalAreaOfOverlappingEntities(entity.layer, layerGroup, checkedOverlappingLayers);
        if (totalArea > MAX_CLUSTER_SIZE) {
            return { triggered: true, severity: Severity.High, shortMessage: `We need some space between these camps` };
        }
        return { triggered: false };
    });

function getBBoxForCoords(coords: Array<Array<number>>): Array<number> {
    // input coords -> [lat,lng]...
    const bbox = [null, null, null, null]; // west,south,east,north
    let firstCoord = true;
    for (let coord of coords) {
        if (firstCoord) {
            bbox[0] = coord[0];
            bbox[2] = coord[0];
            bbox[1] = coord[1];
            bbox[3] = coord[1];
            firstCoord = false;
        } else {
            //lngs
            if (coord[0] < bbox[0]) bbox[0] = coord[0];
            if (coord[0] > bbox[2]) bbox[2] = coord[0];
            // lats
            if (coord[1] < bbox[1]) bbox[1] = coord[1];
            if (coord[1] > bbox[3]) bbox[3] = coord[1];
        }
    }
    return bbox;
}

function fastIsOverlap(layerBBox: Array<number>, otherBBox: Array<number>) {
    // input  bounding boxes: [west,south,east,north]

    // Takes two bounding boxes and returns true if the bounding boxes overlap.
    // If the bounding boxes do not overlap then the polygins contained in eahc bounding box also do not.
    // this is a fast way to precheck overlaps

    // check if approx bounding boxes overlap
    if (
        otherBBox[0] > layerBBox[2] ||
        otherBBox[2] < layerBBox[0] ||
        otherBBox[3] < layerBBox[1] ||
        otherBBox[1] > layerBBox[3]
    ) {
        return false;
    }
    return true;
}
function _getTotalAreaOfOverlappingEntities(
    layer: L.Layer,
    layerGroup: L.LayerGroup,
    checkedOverlappingLayers: Set<string>,
): number {
    //@ts-ignore
    if (checkedOverlappingLayers.has(layer._leaflet_id)) {
        return 0;
    } else {
        //@ts-ignore
        checkedOverlappingLayers.add(layer._leaflet_id);
    }

    let totalArea: number;
    //@ts-ignore
    if (clusterCache.areaIsCached(layer._leaflet_id)) {
        //@ts-ignore
        totalArea = clusterCache.getAreaCache(layer._leaflet_id);
    } else {
        //@ts-ignore
        totalArea = Turf.area(layer.toGeoJSON());
        //@ts-ignore
        clusterCache.setAreaCache(layer._leaflet_id, totalArea);
    }

    // get an approximate bounding box with firebuffer padding to use for later calculations

    //@ts-ignore
    /* you can get bounds like so:
    const bounds = layer.getBounds()
    let boxBounds = [bounds._southWest.lng,bounds._southWest.lat,bounds._northEast.lng,bounds._northEast.lat]
    However, layer.getBounds is not updated when moving the layer. Need to call layer.geoJson for an udpated bounds.
    */
    //@ts-ignore
    let boxBounds = getBBoxForCoords(layer.toGeoJSON().features[0].geometry.coordinates[0]);
    //@ts-ignore
    const bBox = ruler.bufferBBox(boxBounds, CHEAP_RULER_BUFFER); // add buffer padding to box

    //@ts-ignore
    layerGroup.eachLayer((otherLayer) => {
        if (!_compareLayers(layer, otherLayer)) {
            let overlaps; // becomes true if the two layers overlap
            //@ts-ignore
            if (clusterCache.overlapIsCached(layer._leaflet_id, otherLayer._leaflet_id)) {
                //@ts-ignore
                overlaps = clusterCache.getOverlapCache(layer._leaflet_id, otherLayer._leaflet_id);
            } else {
                // Overlap is not cached -> calculate it
                //@ts-ignore
                const otherBounds = otherLayer.getBounds();
                let otherBoxBounds = [
                    otherBounds._southWest.lng,
                    otherBounds._southWest.lat,
                    otherBounds._northEast.lng,
                    otherBounds._northEast.lat,
                ];
                //@ts-ignore
                const otherBbox = otherBoxBounds; // We already padded layer. No need to pad otherLayer also
                // check if approx bounding boxes overlap
                if (!fastIsOverlap(bBox, otherBbox)) {
                    // bounding boxes do not overlap so polygons also dont overlap
                    overlaps = false;
                    //@ts-ignore
                    clusterCache.setOverlapCache(layer._leaflet_id, otherLayer._leaflet_id, overlaps);
                } else {
                    // bounding boxes overlap so polygons might overlap. Time to do the expensive calculations

                    //@ts-ignore
                    const otherLayerGeoJSON = otherLayer.toGeoJSON();
                    let otherLayerPolygon;
                    if (otherLayerGeoJSON.type === 'Feature') {
                        otherLayerPolygon = otherLayerGeoJSON.geometry;
                    } else if (otherLayerGeoJSON.type === 'FeatureCollection') {
                        otherLayerPolygon = otherLayerGeoJSON.features[0];
                    } else {
                        // Unsupported geometry type
                        throw new Error('unsupported geometry');
                    }

                    //@ts-ignore
                    let buffer = Turf.buffer(layer.toGeoJSON(), FIRE_BUFFER_IN_METER, {
                        units: 'meters',
                    }) as Turf.helpers.FeatureCollection<Turf.helpers.Polygon>;
                    if (
                        Turf.booleanOverlap(buffer.features[0], otherLayerPolygon) ||
                        Turf.booleanContains(buffer.features[0], otherLayerPolygon)
                    ) {
                        overlaps = true;
                    } else {
                        overlaps = false;
                    }
                    //@ts-ignore
                    clusterCache.setOverlapCache(layer._leaflet_id, otherLayer._leaflet_id, overlaps);
                }
            }
            if (overlaps) {
                totalArea += _getTotalAreaOfOverlappingEntities(otherLayer, layerGroup, checkedOverlappingLayers);
            }
        }
    });

    return totalArea;
}

function _compareLayers(layer1: L.Layer, layer2: L.Layer): boolean {
    //@ts-ignore
    return layer1._leaflet_id === layer2._leaflet_id;
}

const isBreakingSoundLimit = (layerGroup: any, severity: Severity, shortMsg: string, message: string) =>
    new Rule(severity, shortMsg, message, (entity) => {
        if (entity.amplifiedSound === undefined) return { triggered: false };

        let geoJson = entity.toGeoJSON();
        let overlap = false;

        layerGroup.eachLayer((layer) => {
            //@ts-ignore
            let otherGeoJson = layer.toGeoJSON();
            let limitQuiet = 10;
            let limitLow = 120;
            let limitMediumLow = 2000;
            let limitMedium = 2000;

            //Loop through all features if it is a feature collection
            if (otherGeoJson.features) {
                for (let i = 0; i < otherGeoJson.features.length; i++) {
                    if (
                        Turf.booleanOverlap(geoJson, otherGeoJson.features[i]) ||
                        Turf.booleanContains(otherGeoJson.features[i], geoJson)
                    ) {
                        if (
                            otherGeoJson.features[i].properties.type == 'soundquiet' &&
                            entity.amplifiedSound > limitQuiet
                        ) {
                            overlap = true;
                            return;
                        } else if (
                            otherGeoJson.features[i].properties.type == 'soundlow' &&
                            entity.amplifiedSound > limitLow
                        ) {
                            overlap = true;
                            return;
                        } else if (
                            otherGeoJson.features[i].properties.type == 'soundmediumlow' &&
                            entity.amplifiedSound > limitMediumLow
                        ) {
                            overlap = true;
                            return;
                        } else if (
                            otherGeoJson.features[i].properties.type == 'soundmedium' &&
                            entity.amplifiedSound > limitMedium
                        ) {
                            overlap = true;
                            return;
                        }
                    }
                }
            } else if (Turf.booleanOverlap(geoJson, otherGeoJson) || Turf.booleanContains(otherGeoJson, geoJson)) {
                if (otherGeoJson.properties.type == 'soundquiet' && entity.amplifiedSound > limitQuiet) {
                    overlap = true;
                    return;
                } else if (otherGeoJson.properties.type == 'soundlow' && entity.amplifiedSound > limitLow) {
                    overlap = true;
                    return;
                } else if (otherGeoJson.properties.type == 'soundmediumlow' && entity.amplifiedSound > limitMediumLow) {
                    overlap = true;
                    return;
                } else if (otherGeoJson.properties.type == 'soundmedium' && entity.amplifiedSound > limitMedium) {
                    overlap = true;
                    return;
                }
            }

            if (overlap) {
                return; // Break out of the loop once an overlap is found
            }
        });

        return { triggered: overlap };
    });
