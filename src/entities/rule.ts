import * as Turf from '@turf/turf';
import type { MapEntity } from './entity';

const MAX_SQM_FOR_ENTITY: number = 1500;
const MAX_POWER_NEED: number = 7000;
const MAX_POINTS_BEFORE_WARNING: number = 8;

export class Rule {
    private _severity: 0 | 1 | 2 | 3;
    private _triggered: boolean;
    private _callback: (entity: MapEntity) => boolean;

    public readonly message: string;
    public readonly shortMessage: string;

    public get severity(): number {
        return this._triggered ? this._severity : 0;
    }

    public get triggered(): boolean {
        return this._triggered;
    }

    public checkRule(entity: MapEntity) {
        // const b = this._triggered;
        this._triggered = this._callback(entity);
        // const a = this._triggered;
        // if (a != b) {
        //     console.log('changed to', a, this.shortMessage);
        // }
    }

    constructor(severity: Rule['_severity'], shortMessage: string, message: string, callback: Rule['_callback']) {
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
        isTooBig(),
        hasManyCoordinates(),
        hasLargeEnergyNeed(),
        hasMissingFields(),
        isBiggerThanNeeded(),
        isSmallerThanNeeded(),
        isCalculatedAreaTooBig(),
        isOverlapping(groups.fireroad, 3, 'Watch the fireroad!','This area is overlapping a fire road, adjust the placement plz <3'),
        isBufferOverlapping(placementLayers, 3, 'Too close!','Fire safety distance warning! The dotted line can not touch another area.'),
        isNotInsideBoundaries(groups.propertyborder, 3, 'Outside border.','You have placed yourself outside our land, please fix that <3'),
        isNotInsideBoundaries(groups.highprio, 2, 'Outside placement areas.', 'You are outside the placement area (yellow border)!'),
        isInsideBoundaries(groups.hiddenforbidden, 3, 'Inside forbidden zone!', 'You are inside a zone that can not be used this year.'),
        isOverlapping(groups.slope, 1, 'Slopey!','Your area are in slopey and uneven terrain, make sure to check the slope map layer to make sure that you know what you are doing :)'),
        isInsideBoundaries(groups.slope, 1, 'Slopey!','Your area are in slopey and uneven terrain, make sure to check the slope map layer to make sure that you know what you are doing :)'),
    ];
}

const isTooBig = () =>
    new Rule(3, 'Too big!', 'Area is too big! Max size for one area is 500 m². Add another so that a fire safety buffer is created in between.', (entity) => {
        return entity.area > MAX_SQM_FOR_ENTITY;
    });

const hasManyCoordinates = () =>
    new Rule(1, 'Many points.', 'You have added many points to this shape. Bear in mind that you will have to set this shape up in reality as well :)', (entity) => {
        const geoJson = entity.toGeoJSON();
        //Dont know why I have to use [0] here, but it works
        return geoJson.geometry.coordinates[0].length > MAX_POINTS_BEFORE_WARNING;
    });

const hasLargeEnergyNeed = () =>
    new Rule(1, 'Powerful.', 'You need a lot of power, make sure its not a typo.', (entity) => {
        return entity.powerNeed > MAX_POWER_NEED;
    });

const hasMissingFields = () =>
    new Rule(2, 'Missing info', 'Fill in name and description please.', (entity) => {
        return !entity.name || !entity.description || !entity.contactInfo;
    });

const isCalculatedAreaTooBig = () =>
    new Rule(3, 'Too many ppl/vehicles!', 'Calculated area need is bigger than the maximum allowed area size! Make another area to fix this.', (entity) => {
        return entity.calculatedAreaNeeded > MAX_SQM_FOR_ENTITY;
    });

const isBiggerThanNeeded = () =>
    new Rule(2, 'Bigger than needed.', 'Are you aware that the area is much bigger than the calculated need?', (entity) => {
        const allowedArea = calculateAllowedArea(entity.calculatedAreaNeeded);
        return entity.area > allowedArea;
    });

function calculateAllowedArea(calculatedNeed: number): number {
  // Define constants for the power function
  const a = 0.5; // Controls the initial additional area
  const b = -0.2; // Controls the rate of decrease of the additional area

  // Calculate the additional area percentage using a power function
  const additionalArea = a * Math.pow(calculatedNeed, b);

  // Clamp the additional area between 0 and a
  const clampedAdditionalArea = Math.max(0, Math.min(additionalArea, a));

  // Calculate the allowed area
  const allowedArea = Math.min(calculatedNeed * (1 + clampedAdditionalArea), MAX_SQM_FOR_ENTITY);
  
  return allowedArea;
}

const isSmallerThanNeeded = () =>
    new Rule(
        2,
        'Too small.',
        'Are you aware that the area is smaller than the calculated need? Consider making it larger.',
        (entity) => {
            return entity.area < entity.calculatedAreaNeeded;
        },
    );

const isOverlapping = (layerGroup: any, severity: Rule["_severity"], shortMsg: string, message: string) =>
    new Rule(severity, shortMsg,message, (entity) => {
        return _isGeoJsonOverlappingLayergroup(entity.toGeoJSON(), layerGroup);
    });

const isBufferOverlapping = (layerGroup: any, severity: Rule["_severity"], shortMsg: string, message: string) =>
    new Rule(severity, shortMsg, message, (entity) => {
        //Get the first feature of the buffer layer, since toGeoJSON() always returns a feature collection
        if (!entity.bufferLayer) {
            return false;
        }
        return _isGeoJsonOverlappingLayergroup(
            //@ts-ignore
            entity.bufferLayer.toGeoJSON().features[0],
            layerGroup as any,
        );
    });

const isInsideBoundaries = (layerGroup: any, severity: Rule["_severity"], shortMsg: string, message: string) =>
    checkEntityBoundaries(layerGroup, severity, shortMsg, message, true);

const isNotInsideBoundaries = (layerGroup: any, severity: Rule["_severity"], shortMsg: string, message: string) =>
    checkEntityBoundaries(layerGroup, severity, shortMsg, message, false);

const checkEntityBoundaries = (
    layerGroup: any,
    severity: Rule["_severity"],
    shortMsg: string,
    message: string,
    shouldBeInside: boolean
    ) =>
        new Rule(severity, shortMsg, message, (entity) => {
            const layers = layerGroup.getLayers();

            for (const layer of layers) {
                let otherGeoJson = layer.toGeoJSON();

                // Loop through all features if it is a feature collection
                if (otherGeoJson.features) {
                    for (let i = 0; i < otherGeoJson.features.length; i++) {
                        if (Turf.booleanContains(otherGeoJson.features[i], entity.toGeoJSON())) {
                            return shouldBeInside;
                        }
                    }
                } else if (Turf.booleanContains(otherGeoJson, entity.toGeoJSON())) {
                    return shouldBeInside;
                }
            }

            return !shouldBeInside;
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
