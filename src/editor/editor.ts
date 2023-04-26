import * as L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import { MapEntity, MapEntityRepository, DefaultLayerStyle } from '../entities';
import { generateRulesForEditor } from '../entities/rule';
import * as Turf from '@turf/turf';

/**
 * The Editor class keeps track of the user status regarding editing and
 * renders the map entities in the repository as editable layers on the map
 */
export class Editor {
    /** The Map Entities repository being used */
    private _repository: MapEntityRepository;
    /** The Leaflet Map being used */
    private _map: L.Map;
    /** A Leaflet popup used to display information and choices for individual editable layers */
    private _popup: L.Popup;

    /** If the editor should be active or not */
    private _isEditMode: boolean = false;

    /** The current status of the editor */
    private _mode: 'none' | 'selected' | 'editing-shape' | 'editing-info' = 'none';

    /** The currently selected map entity, if any */
    private _selected: MapEntity | null = null;

    private _groups: L.FeatureGroup<any>;
    private _placementLayers: L.LayerGroup<any>;
    private _placementBufferLayers: L.LayerGroup<any>;
    
    private onScreenInfo: any; //The little bottom down thingie that shows the current area and stuff

    /** Updates current editor status - blur indicates that the current mode should be redacted */
    private async setMode(nextMode: Editor['_mode'] | 'blur', nextEntity?: MapEntity) {
        const prevMode = this._mode;
        const prevEntity = this._selected;
        const isSameMode = nextMode == prevMode;
        const isSameEntity = nextEntity == prevEntity;

        // Skip mode change
        if (isSameMode && isSameEntity) {
            return;
        }

        // When blur is sent as parameter, the next mode is dynamicly determined
        if (nextMode == 'blur') {
            if ((prevMode == 'editing-shape' || prevMode == 'editing-info') && prevEntity) {
                nextMode = 'selected';
                nextEntity = nextEntity || prevEntity;
                //re-center the pop up on the new layer, in case the layer has moved
                // far away during edit, as clicking the map wont set the popups position to the new layer
                //@ts-ignore
                const bounds = nextEntity.layer.getBounds();
                const latlng = bounds.getCenter();
                this._popup.setLatLng(latlng);
            }
            // Fall back to the "none" mode
            else {
                nextMode = 'none';
                nextEntity = undefined;
            }
        }

        // Set the correct mode
        console.log('[Editor]', 'mode changed!', { mode: this._mode, nextMode, nextEntity });
        this._mode = nextMode as Editor['_mode'];

        // Handle effects of setting the correct mode

        // Deselect and stop editing
        if (this._mode == 'none') {
            this.setPopup('none');
            this.setSelected(null, prevEntity);
            return;
        }

        // Select an entity for editing
        if (this._mode == 'selected' && nextEntity) {
            this.setPopup('info', nextEntity);
            this.setSelected(nextEntity, prevEntity);

            // Stop any ongoing editing of the previously selected layer
            if (prevEntity) {
                prevEntity?.layer.pm.disable();
            }

            return;
        }
        // Edit the shape of the entity
        if (this._mode == 'editing-shape' && nextEntity) {
            nextEntity.layer.pm.enable({ editMode: true, snappable: false});
            this.setPopup('none');
            this.setSelected(nextEntity, prevEntity);
            return;
        }
        // Edit the information of the entity
        if (this._mode == 'editing-info' && nextEntity) {
            this.setPopup('edit-info', nextEntity);
            this.setSelected(nextEntity, prevEntity);
            return;
        }
    }

    /** Updates the currently selected map entity  */
    private async setSelected(nextEntity: MapEntity | null, prevEntity: MapEntity | null) {
        // When a map entity is unselected, save it to the database if it has changes
        if (prevEntity && nextEntity != prevEntity && prevEntity.hasChanges()) {
            await this.onLayerDoneEditing(prevEntity);
        }

        if (this._isEditMode) {
            this.UpdateOnScreenDisplay(nextEntity);
        }

        // Select the next entity
        this._selected = nextEntity;
    }

    /** Updates whats display in the pop up window, if anything - usually called from setMode */
    private setPopup(display: 'info' | 'edit-info' | 'none', entity?: MapEntity | null) {
        // Don't show any pop-up if set to none or if there is no entity
        if (display == 'none' || !entity) {
            this._popup.close();
            return;
        }

        // Show information popup for the entity
        if (display == 'info') {
            const content = document.createElement('div');

            const personText = entity.nrOfPeople === "1" ? 'person' : 'people';
            const vehicleText = entity.nrOfVehicles === "1" ? 'vehicle' : 'vehicles';

            content.innerHTML = `<h2>${entity.name}</h2>
                                <p class="scrollable">${entity.description}</p>
                               
                                <p style="font-size:14px;"><b>${entity.nrOfPeople}</b> ${personText} and <b>${entity.nrOfVehicles}</b> ${vehicleText} together 
                                with <b>${entity.additionalSqm}</b>m² of additional structures are here. They will need roughly <b>${entity.calculatedAreaNeeded}</b>m² </p>
                                 
                                <p style="font-size:14px;">
                                    <b>Contact:</b> ${entity.contactInfo}   
                                    </br>
                                    <b>Actual Area:</b> ${entity.area} m²
                                    <b style="text-align:right;">Power need:</b> ${entity.powerNeed} Watts
                                </p> 
                                `;

            const sortedRules = entity.getAllTriggeredRules().sort((a, b) => b.severity - a.severity);

            if (sortedRules.length > 0)
            {
                content.innerHTML += `<p><b>${sortedRules.length}</b> issues found:</p> `;

                for (const rule of sortedRules) {
                    if (rule.severity >= 3) {
                        content.innerHTML += `<p class="error">${' ' + rule.message}</p>`;
                    } else if (rule.severity >= 2) {
                        content.innerHTML += `<p class="warning">${' ' + rule.message}</p>`;
                    } else {
                        content.innerHTML += `<p class="info">${' ' + rule.message}</p>`;
                    }
                }
            }

            if (this._isEditMode) {
                const editShapeButton = document.createElement('button');
                editShapeButton.innerHTML = 'Edit shape';
                editShapeButton.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.setMode('editing-shape', entity);
                };

                content.appendChild(editShapeButton);

                const editInfoButton = document.createElement('button');
                editInfoButton.innerHTML = 'Edit info';
                editInfoButton.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.setMode('editing-info', entity);
                };
                content.appendChild(editInfoButton);

                // const info = document.createElement('div');
                // info.innerHTML = `<p>id: ${entity.id}, rev: ${entity.revision}</p>`;
                // content.appendChild(info);
            }

            this._popup.setContent(content).openOn(this._map);
            return;
        }

        // Show fields to edit the entity information
        if (display == 'edit-info') {
            const content = document.createElement('div');
            content.innerHTML = ``;

            content.appendChild(document.createElement('label')).innerHTML = 'Name of camp/project';
            
            const nameField = document.createElement('input');
            nameField.type = 'text';
            nameField.value = entity.name;
            nameField.oninput = () => {
                entity.name = nameField.value;
                entity.checkAllRules();
            };
            content.appendChild(nameField);

            content.appendChild(document.createElement('br'));
            content.appendChild(document.createElement('label')).innerHTML = 'Description';

            const descriptionField = document.createElement('textarea');
            descriptionField.value = entity.description;
            descriptionField.oninput = () => {
                entity.description = descriptionField.value;
                entity.checkAllRules();
            };
            content.appendChild(descriptionField);

            content.appendChild(document.createElement('label')).innerHTML = 'Contact info (Name/email/discord)';
            const contactField = document.createElement('input');
            contactField.type = 'text';
            contactField.value = entity.contactInfo;
            contactField.oninput = () => {
                entity.contactInfo = contactField.value;
                entity.checkAllRules();
            };
            content.appendChild(contactField);

            content.appendChild(document.createElement('br'));
            content.appendChild(document.createElement('label')).innerHTML = 'People in tents';

            const peopleField = document.createElement('input');
            peopleField.size = 4;
            peopleField.maxLength = 3;
            peopleField.type = 'number';
            peopleField.value = String(entity.nrOfPeople);
            peopleField.min = '0';
            peopleField.oninput = () => {
                entity.nrOfPeople = peopleField.value;
                entity.checkAllRules();
            };
            content.appendChild(peopleField);

            content.appendChild(document.createElement('br'));
            content.appendChild(document.createElement('label')).innerHTML = 'Vehicles';

            const vehiclesField = document.createElement('input');
            vehiclesField.size = 4;
            vehiclesField.maxLength = 2;
            vehiclesField.type = 'number';
            vehiclesField.value = String(entity.nrOfVehicles);
            vehiclesField.min = '0';
            vehiclesField.oninput = () => {
                entity.nrOfVehicles = vehiclesField.value;
                entity.checkAllRules();
            };
            content.appendChild(vehiclesField);

            content.appendChild(document.createElement('br'));
            content.appendChild(document.createElement('label')).innerHTML = 'Other m²';

            const otherSqm = document.createElement('input');
            otherSqm.size = 4;
            otherSqm.maxLength = 3;
            otherSqm.type = 'number';
            otherSqm.value = String(entity.additionalSqm);
            otherSqm.min = '0';
            otherSqm.oninput = () => {
                entity.additionalSqm = otherSqm.value;
                entity.checkAllRules();
            };
            content.appendChild(otherSqm);

            content.appendChild(document.createElement('br'));
            content.appendChild(document.createElement('label')).innerHTML = 'Power need (Watts)';

            const powerField = document.createElement('input');
            powerField.size = 6;
            powerField.maxLength = 5;
            powerField.type = 'number';
            powerField.value = String(entity.powerNeed);
            powerField.min = '0';
            powerField.oninput = () => {
                //@ts-ignore
                entity.powerNeed = powerField.value;
                entity.checkAllRules();
            };
            content.appendChild(powerField);

            content.appendChild(document.createElement('p'));

            if (this._isEditMode) {
                const saveInfoButton = document.createElement('button');
                saveInfoButton.innerHTML = 'Save';
                saveInfoButton.onclick = async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.setMode('blur');
                };
                content.appendChild(saveInfoButton);

                const deleteButton = document.createElement('button');
                deleteButton.classList.add('delete-button');
                deleteButton.innerHTML = 'Delete';
                deleteButton.onclick = async (e) => {
                    if (!confirm('Are you sure you want to delete this entity?')) {
                        return;
                    }
                    e.stopPropagation();
                    e.preventDefault();
                    this.deleteAndRemoveEntity(entity);
                };
                content.appendChild(deleteButton);
            }

            this._popup.setContent(content).openOn(this._map);
            return;
        }
    }

    /** Event handler for when an editable map entity is clicked */
    private async onLayerClicked(entity: MapEntity) {
        console.log('[Editor]', 'Click event fired', { entity });

        this.setMode('selected', entity);
    }

    /** Event handler for when an editable map entity has been edited */
    private async onLayerDoneEditing(entity: MapEntity) {
        console.log('[Editor]', 'onLayerDoneEditing!', { selected: this._selected });
        // Stop editing
        entity.layer.pm.disable();

        this.UpdateOnScreenDisplay(null);

        // Update the entity with the response from the API
        const entityInResponse = await this._repository.updateEntity(entity);

        if (entityInResponse) {
            this.addEntityToMap(entityInResponse);
            this._map.removeLayer(entity.layer);
            this._map.removeLayer(entity.bufferLayer);
            this._placementLayers.removeLayer(entity.layer);
            this._placementBufferLayers.removeLayer(entity.bufferLayer);
        }
    }

    private UpdateOnScreenDisplay(entity: MapEntity | null) {
        if (entity) {
            this.onScreenInfo.textContent = entity.area + "m²";

            for (const rule of entity.getAllTriggeredRules()) {
                if (rule.severity >= 3) {
                    this.onScreenInfo.textContent = rule.shortMessage;
                }
            }
        }
        else {
            this.onScreenInfo.textContent = "";
        }
    }

    /** Event handler for when an new layer is created */
    private async onNewLayerCreated(createEvent: { layer: L.Layer }) {
        console.log('[Editor]', 'Create event fired', { createEvent });

        // Get the newly created layer as GeoJson
        const { layer } = createEvent;
        //@ts-ignore
        const geoJson = layer.toGeoJSON();

        //Use turf to check the area of the polygon
        //@ts-ignore
        const area = Turf.area(geoJson);
        
        if (area > 1000) {
            alert("The area of the polygon is waaay to big. Draw something smaller.");
            this._map.removeLayer(layer);
            return;
        }

        // Save it to the entity API
        const entity = await this._repository.createEntity(geoJson);

        // Remove the drawn layer and replace it with one bound to the entity
        if (entity) {
            this.addEntityToMap(entity);
            this._map.removeLayer(layer);
            //@ts-ignore
            const bounds = entity.layer.getBounds();
            const latlng = bounds.getCenter();
            this._popup.setLatLng(latlng);
            this.setMode('editing-info', entity);
        }
    }

    /** Adds the given map entity as an a editable layer to the map */
    private addEntityToMap(entity: MapEntity) {
        // Bind the click-event of the editor to the layer
        entity.layer.on('click', ({ latlng }) => {
            // Update the popup-position
            this._popup.setLatLng(latlng);
            // Call the click event
            this.onLayerClicked(entity);
        });

        // Update the buffered layer when the layer is being edited
        entity.layer.on('pm:markerdrag', () => {
            entity.updateBufferedLayer();
            entity.checkAllRules();
            
            this.UpdateOnScreenDisplay(entity);
        });

        // Update the buffered layer when the layer has a vertex removed
        entity.layer.on('pm:vertexremoved', () => {
            entity.updateBufferedLayer();
        });

        //Instead of adding directly to the map, add the layer and its buffer to the layergroups
        //@ts-ignore
        this._placementLayers.addLayer(entity.layer);
        //@ts-ignore
        this._placementBufferLayers.addLayer(entity.bufferLayer);

        //Set initial opacity of the bufferlayer depending on the zoomlevel (REFACTOR this and how its done in the onZoomEnd event)
        if (this._map.getZoom() < 19) {
            //@ts-ignore
            entity.bufferLayer.setStyle({ opacity: 0 });
        }

        entity.checkAllRules();
    }

    private deleteAndRemoveEntity(entity: MapEntity) {
        this._selected = null;
        this.setMode('none');
        this._placementLayers.removeLayer(entity.layer);
        this._map.removeLayer(entity.layer);
        this._map.removeLayer(entity.bufferLayer);
        this._repository.deleteEntity(entity);
    }

    constructor(map: L.Map, groups: L.FeatureGroup) {
        // Keep track of the map
        this._map = map;

        this._groups = groups;

        //Create two separate layersgroups, so that we can use them to check overlaps separately
        this._placementLayers = new L.LayerGroup().addTo(map);
        this._placementBufferLayers = new L.LayerGroup().addTo(map);

        //Place both in the same group so that we can toggle them on and off together on the map
        //@ts-ignore
        groups.placement = new L.LayerGroup().addTo(map);
        //@ts-ignore
        this._placementLayers.addTo(groups.placement);
        //@ts-ignore
        this._placementBufferLayers.addTo(groups.placement);

        
        //Hide buffers when zoomed out
        var bufferLayers = this._placementBufferLayers;
        map.on('zoomend', function () {
            if (map.getZoom() >= 19) {
                bufferLayers.getLayers().forEach(function (layer) {
                    //@ts-ignore
                    layer.setStyle({ opacity: 1 });
                });
            } 
            else {
                bufferLayers.getLayers().forEach(function (layer) {
                    //@ts-ignore
                    layer.setStyle({ opacity: 0 });
                });
            }
        });

        // Generate rules that the entities must follow
        const rules = generateRulesForEditor(this._groups, this._placementLayers);

        // Keep track of the entities repository
        this._repository = new MapEntityRepository(rules);

        // Create a common popup for editable layers
        this._popup = L.popup({
            autoClose: false,
            closeButton: false,
            closeOnClick: false,
            closeOnEscapeKey: false,
        });

        // Disable edit mode on all layers by default
        L.PM.setOptIn(true);

        this.AddToggleEditButton();

        // add controls for creating and editing shapes to the map
        this._map.pm.addControls({
            position: 'bottomleft',
            drawPolygon: false,
            drawCircle: false,
            drawMarker: false,
            drawPolyline: false,
            drawRectangle: false,
            drawCircleMarker: false,
            drawText: false,
            removalMode: false,
            editControls: false,
        });

        // Set path style options for newly created layers
        this._map.pm.setPathOptions(DefaultLayerStyle);
        this._map.pm.setGlobalOptions({ tooltips: false, allowSelfIntersection: false }); // Disable snapping

        // Add the event handler for newly created layers
        this._map.on('pm:create', this.onNewLayerCreated.bind(this));

        // Add a click event to the map to reset the editor status.
        this._map.on('click', (mouseEvent) => {
            console.log('[Editor]', 'Editor blur event fired (map click)', { mouseEvent });
            this.setMode('blur');
        });

        this.onScreenInfo = document.querySelector(".entity-onscreen-info");
    }

    private AddToggleEditButton() {
        const customButton = L.Control.extend({
            // button position
            options: { position: 'bottomleft' },

            onAdd: () => {
                // create button
                let btn = L.DomUtil.create('button', 'placement-btn');
                btn.title = 'Start Placement!';
                btn.textContent = 'Start Placement!';
                L.DomEvent.disableClickPropagation(btn);

                btn.onclick = () => {
                    this.toggleEditMode();
                    btn.textContent = this._isEditMode ? 'Exit edit mode' : 'Start Placement!';
                    btn.title = this._isEditMode ? 'Exit edit mode' : 'Start Placement!';
                };

                return btn;
            },
        });

        this._map.addControl(new customButton());
    }

    public async toggleEditMode() {
        this._isEditMode = !this._isEditMode;

        // if (localStorage.getItem("hasSeenInstructions") == null)
        // {
        //     localStorage.setItem("hasSeenInstructions", "true");

            // Show instructions when entering edit mode, and wait for the user 
            // to press a button on that screen before continuing
            if (this._isEditMode){
                await this.ShowInstructionsScreenAndWait();
            }
        // }

        //Make sure to update the contents of the popup when changing edit mode
        //so that the correct buttons are shown
        this.setPopup('info', this._selected);

        if (this._isEditMode == false && this._mode != 'selected') {
            this.setMode('none');
        }

        this._map.pm.addControls({
            drawPolygon: this._isEditMode,
        });
    }

    ShowInstructionsScreenAndWait() {
        return new Promise((resolve) => {
            const instructions = document.querySelector(".instructions");
            const pageOne = document.getElementById("pageOne");
            const pageTwo = document.getElementById("pageTwo");

            if (instructions != null && pageOne != null && pageTwo != null)
            {
                //Inactivate the customButton
                const customButton = document.querySelector(".placement-btn");
                customButton?.setAttribute("disabled", "");

                //Show the instructions screen
                instructions.removeAttribute("hidden");   
                
                //Create the content for pageOne
                const nextButton = document.createElement('button');
                //Center this button in its div
                nextButton.style.margin = "auto";
                nextButton.style.display = "block";
                nextButton.innerHTML = 'NEXT >';
                nextButton.onclick = (e) => {
                    pageOne.setAttribute("hidden", "");
                    pageTwo.removeAttribute("hidden");
                };
                pageOne.appendChild(nextButton);

                //Create the content for pageTwo
                const okButton = document.createElement('button');
                //Center this button in its div
                okButton.style.margin = "auto";
                okButton.style.display = "block";
                okButton.innerHTML = 'Let\'s go!';
                okButton.onclick = (e) => {
                    instructions.setAttribute("hidden", "");
                    resolve(true);
                }
                pageTwo.appendChild(okButton);
            }
            else {
                resolve(true);
            }
        });
        
    }

    /** Add each existing map entity from the API as an editable layer */
    public async addAPIEntities() {
        const entities = await this._repository.entities();

        for (const entity of entities) {
            this.addEntityToMap(entity);
        }
    }
}
