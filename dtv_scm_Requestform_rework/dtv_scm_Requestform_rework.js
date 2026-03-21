import { LightningElement, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';

import { gql, graphql, refreshGraphQL } from 'lightning/uiGraphQLApi';
import { createRecord, updateRecord, deleteRecord } from 'lightning/uiRecordApi';
import USER_ID from '@salesforce/user/Id';

// ProductRequest schema tokens
import PR_OBJECT      from '@salesforce/schema/ProductRequest';
import PR_STATUS      from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION from '@salesforce/schema/ProductRequest.Description';
import PR_NEED_BY_DATE from '@salesforce/schema/ProductRequest.NeedByDate';
import PR_ID          from '@salesforce/schema/ProductRequest.Id';
import PR_SHIPMENT_TYPE from '@salesforce/schema/ProductRequest.ShipmentType';

// ProductRequestLineItem schema tokens
import PRLI_OBJECT        from '@salesforce/schema/ProductRequestLineItem';
import PRLI_PR_ID         from '@salesforce/schema/ProductRequestLineItem.ParentId';
import PRLI_PRODUCT2_ID   from '@salesforce/schema/ProductRequestLineItem.Product2Id';
import PRLI_QTY_REQUESTED from '@salesforce/schema/ProductRequestLineItem.QuantityRequested';
import PRLI_STATUS        from '@salesforce/schema/ProductRequestLineItem.Status';

// Resource Product schema tokens — used to update Default Quantity on Save
// DTVSCM_Default_Quantity__c is updated ONLY after user clicks Save
import RP_OBJECT     from '@salesforce/schema/DTVSCM_Resource_Product__c';
import RP_ID         from '@salesforce/schema/DTVSCM_Resource_Product__c.Id';
import RP_DEFAULT_QTY from '@salesforce/schema/DTVSCM_Resource_Product__c.DTVSCM_Default_Quantity__c';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 1 — ServiceResource for running user
// ─────────────────────────────────────────────────────────────────────────────
const GET_SERVICE_RESOURCE_QUERY = gql`
    query GetServiceResource($userId: ID) {
        uiapi {
            query {
                ServiceResource(
                    where: { RelatedRecordId: { eq: $userId } }
                    first: 1
                ) {
                    edges {
                        node { Id Name { value } }
                    }
                }
            }
        }
    }
`;

/**
 * GraphQL QUERY 2 — Latest ProductRequest for running user
 * Metadata is used only for writes; filtering happens client-side.
 */
const GET_DRAFT_PR_QUERY = gql`
    query GetDraftPR($userId: ID, $shipmentType: Picklist) {
        uiapi {
            query {
                ProductRequest(
                    where: { CreatedById: { eq: $userId }, ShipmentType: { eq: $shipmentType } }
                    orderBy: { CreatedDate: { order: DESC } }
                    first: 1
                ) {
                    edges {
                        node {
                            Id
                            ProductRequestNumber { value }
                            Status { value }
                            NeedByDate { value }
                        }
                    }
                }
            }
        }
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 3 — All Resource Products (filtered client-side by SR)
// ─────────────────────────────────────────────────────────────────────────────
const GET_RESOURCE_PRODUCTS_QUERY = gql`
    query GetResourceProducts {
        uiapi {
            query {
                DTVSCM_Resource_Product__c(
                    orderBy: { Name: { order: ASC } }
                    first: 200
                ) {
                    edges {
                        node {
                            Id
                            Name                       { value }
                            DTVSCM_ServiceResource__c  { value }
                            DTVSCM_Default_Quantity__c { value }
                            DTVSCM_Product__r {
                                Id
                                Name        { value }
                                Description { value }
                                ProductCode { value }
                            }
                        }
                    }
                }
            }
        }
    }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 4 — PRLIs for active Draft PR (reactive on activePrId)
// ─────────────────────────────────────────────────────────────────────────────
const GET_PRLI_QUERY = gql`
    query GetPrli($prId: ID) {
        uiapi {
            query {
                ProductRequestLineItem(
                    where: { ParentId: { eq: $prId } }
                    first: 500
                ) {
                    edges {
                        node {
                            Id
                            Product2Id { value }
                            QuantityRequested { value }
                        }
                    }
                }
            }
        }
    }
`;

/**
 * Query to fetch Custom Metadata for PR status configuration
 * DTV_SCM_Configuration__mdt with fields:
 *  - DeveloperName
 *  - Value__c (contains actual status string)
 */
const GET_PR_CONFIG_QUERY = gql`
    query GetPrConfig {
        uiapi {
            query {
                DTV_SCM_Configuration__mdt(first: 50, orderBy: { DeveloperName: { order: ASC } }) {
                    edges {
                        node {
                            DeveloperName { value }
                            Value__c { value }
                        }
                    }
                }
            }
        }
    }
`;

export default class Dtvscm_productRequest extends LightningElement {

    // ── formFactor ────────────────────────────────────────────────────────
    get isMobile()  { return FORM_FACTOR === 'Small'; }
    get isDesktop() { return FORM_FACTOR === 'Large'; }

    get shellClass() {
        return FORM_FACTOR === 'Small' ? 'shell shell-mobile' : 'shell shell-desktop';
    }
    get productListClass() {
        return FORM_FACTOR === 'Small' ? 'product-list' : 'product-list product-list-desktop';
    }
    get bottomBarClass() {
        return FORM_FACTOR === 'Small' ? 'bottom-bar bottom-bar-mobile' : 'bottom-bar bottom-bar-desktop';
    }

    // ── Tab state ─────────────────────────────────────────────────────────
    @track activeTab = 'scheduled';

    get isScheduledTab()      { return this.activeTab === 'scheduled'; }
    get isUnscheduledTab()    { return this.activeTab === 'unscheduled'; }
    get scheduledTabClass()   { return this.activeTab === 'scheduled'   ? 'tab-btn active' : 'tab-btn'; }
    get unscheduledTabClass() { return this.activeTab === 'unscheduled' ? 'tab-btn active' : 'tab-btn'; }

    handleTabSwitch(event) {
        const nextTab = event.currentTarget.dataset.tab;
        if (nextTab === this.activeTab) return;
        this._storeActiveTabState();
        // Discard any unsaved qty changes when leaving the Unscheduled tab.
        // Per requirement: changes NOT saved do NOT persist.
        if (this.isUnscheduledTab) {
            this._pendingQtyChanges = new Map();
        }
        this.activeTab = nextTab;
        // Reset _prLoaded so the wire result for the new tab
        // is processed fresh, not skipped as already-loaded.
        this._prLoaded = false;
        this._applyActiveTabState();
    }

    _shipmentTypeForTab(tab) {
        return tab === 'scheduled' ? 'Scheduled' : 'Unscheduled';
    }

    _storeActiveTabState() {
        if (this.isScheduledTab) {
            this.activeScheduledPrId = this.activePrId;
            this.activeScheduledPrStatus = this.activePrStatus;
            this.activeScheduledPrNumber = this.activePrNumber;
            this.scheduledNeedByDate = this.needByDate;
        } else {
            this.activeUnscheduledPrId = this.activePrId;
            this.activeUnscheduledPrStatus = this.activePrStatus;
            this.activeUnscheduledPrNumber = this.activePrNumber;
            this.unscheduledNeedByDate = this.needByDate;
        }
    }

    _applyActiveTabState() {
        if (this.isScheduledTab) {
            this.activePrId = this.activeScheduledPrId || null;
            this.activePrStatus = this.activeScheduledPrStatus || null;
            this.activePrNumber = this.activeScheduledPrNumber || '';
            this.needByDate = this.scheduledNeedByDate || '';
        } else {
            this.activePrId = this.activeUnscheduledPrId || null;
            this.activePrStatus = this.activeUnscheduledPrStatus || null;
            this.activePrNumber = this.activeUnscheduledPrNumber || '';
            this.needByDate = this.unscheduledNeedByDate || '';
        }

        this.prliMap = new Map();
        this.prliQtyMap = new Map();
        this.prliLoaded = false;

        this._applySelectionsFromPrliMap();
        this._applyQuantitiesFromPrliMap();
    }

    // ── Back ──────────────────────────────────────────────────────────────
    handleBack() {
        // Discard any unsaved qty changes on navigation away
        this._pendingQtyChanges = new Map();
        this.dispatchEvent(new CustomEvent('back'));
    }

    // ── Search ────────────────────────────────────────────────────────────
    @track searchTerm = '';
    handleSearch(event) { this.searchTerm = event.target.value; }
    handleClearSearch() { this.searchTerm = ''; }

    // ── Network ───────────────────────────────────────────────────────────
    @track isOnline     = navigator.onLine;
    @track isSyncing    = false;
    @track offlineQueue = [];

    connectedCallback() {
        this._onlineHandler  = this.handleOnline.bind(this);
        this._offlineHandler = this.handleOffline.bind(this);
        window.addEventListener('online',  this._onlineHandler);
        window.addEventListener('offline', this._offlineHandler);
        this.isOnline = navigator.onLine;
    }

    disconnectedCallback() {
        window.removeEventListener('online',  this._onlineHandler);
        window.removeEventListener('offline', this._offlineHandler);
    }

    handleOnline() {
        this.isOnline = true;
        if (this.offlineQueue.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Back Online!',
                message: `${this.offlineQueue.length} request(s) ready to sync.`,
                variant: 'info'
            }));
        }
    }

    handleOffline() {
        this.isOnline = false;
        this.dispatchEvent(new ShowToastEvent({
            title: 'You are Offline',
            message: 'Submissions will be queued and synced when online.',
            variant: 'warning', mode: 'sticky'
        }));
    }

    get networkBannerClass() { return this.isOnline ? 'net-banner online' : 'net-banner offline'; }
    get networkLabel()       { return this.isOnline ? '🟢 Online' : '🔴 Offline — submissions will be queued'; }
    get showSyncButton()     { return this.isOnline && this.offlineQueue.length > 0; }
    get syncLabel()          { return `Sync Now (${this.offlineQueue.length})`; }
    get hasPendingQueue()    { return this.offlineQueue.length > 0; }
    get pendingQueueCount()  { return this.offlineQueue.length; }

    // ─────────────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────────────
    @track allProducts       = [];
    @track activePrId        = null;
    @track activePrStatus    = null;
    @track activePrNumber    = '';
    @track needByDate        = '';
    @track isLoading         = true;
    @track hasWireError      = false;
    @track wireErrorMessage  = '';
    @track serviceResourceId = null;

    @track activeScheduledPrId = null;
    @track activeUnscheduledPrId = null;
    @track activeScheduledPrStatus = null;
    @track activeUnscheduledPrStatus = null;
    @track activeScheduledPrNumber = '';
    @track activeUnscheduledPrNumber = '';
    @track scheduledNeedByDate = '';
    @track unscheduledNeedByDate = '';

    // Internal flags to track which wires have resolved
    _srLoaded  = false;
    _prLoaded  = false;
    _rpLoaded  = false;

    // FIX 2: Cache PR wire result when it fires before config is ready.
    // Processed in wiredPrConfig once config is available.
    _pendingPrWireData = null;

    // Metadata-driven status config (no hardcoded fallbacks)
    @track config = null;
    @track _configLoaded = false;

    get statusDefault() {
        if (!this.config?.defaultStatus) {
            throw new Error('Metadata missing: Default_PR_Status');
        }
        return this.config.defaultStatus;
    }
    get statusSubmit() {
        if (!this.config?.submitStatus) {
            throw new Error('Metadata missing: Submit_PR_Status');
        }
        return this.config.submitStatus;
    }
    get statusShipped() {
        if (!this.config?.shippedStatus) {
            throw new Error('Metadata missing: Submit_PR_Shipped');
        }
        return this.config.shippedStatus;
    }

    get isConfigReady() {
        return !!(
            this.config?.defaultStatus &&
            this.config?.submitStatus &&
            this.config?.shippedStatus
        );
    }

    get isPrReady() {
        return this._prLoaded && this._configLoaded;
    }

    // Raw edges stored so we can rebuild product list after SR resolves
    _rpEdgesAll = [];

    // PRLI map: Product2Id → PRLI Record Id
    @track prliMap   = new Map();
    @track prliQtyMap = new Map();
    @track prliLoaded = false;

    // Unscheduled quantity list (separate from scheduled selection list)
    @track unscheduledProducts = [];

    // ── NEW: Unscheduled-specific state ───────────────────────────────────
    // Tracks whether Unscheduled PR has been submitted this session.
    // Unlike Scheduled, submit does NOT lock the form — user can create a new PR.
    // This flag is reset to false after a successful submit so form unlocks.
    @track _unscheduledSubmitted = false;

    // Pending qty changes (resourceProductId → new qty).
    // Populated on +/-/input. Written to Resource Product.DTVSCM_Default_Quantity__c
    // only on Save. Discarded without Save.
    _pendingQtyChanges = new Map(); // Map(resourceProductId → newQty)
    // ─────────────────────────────────────────────────────────────────────

    // Cached wire results for refreshGraphQL
    _draftPrWire = null;
    _prliWire = null;

    // ─────────────────────────────────────────────────────────────────────
    // @wire 1 — ServiceResource for running user
    //
    // Reactive variable: passes USER_ID at runtime (NOT string interpolation)
    // ────────────────────────���────────────────────────────────────────────
    get srVariables() {
        return { userId: USER_ID };
    }

    @wire(graphql, { query: GET_SERVICE_RESOURCE_QUERY, variables: '$srVariables' })
    wiredServiceResource({ data, errors }) {
        if (data === undefined && errors === undefined) return;

        this._srLoaded = true;

        if (errors) {
            console.error('❌ ServiceResource wire error:', JSON.stringify(errors));
            this.serviceResourceId = null;
            this._tryFinishLoading();
            return;
        }

        if (data) {
            const edges = data?.uiapi?.query?.ServiceResource?.edges || [];
            this.serviceResourceId = edges.length > 0 ? edges[0]?.node?.Id : null;
            console.log('✅ ServiceResource resolved:', this.serviceResourceId || 'NONE');
            this._tryBuildProducts();
            this._tryFinishLoading();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 2 — Draft ProductRequest for running user
    // ───────────────────────────────────────────────────────────────���─────
    get draftPrVariables() {
        // FIX 1: Do NOT gate on isConfigReady here.
        // The PR wire must fire as soon as the component loads, independently
        // of metadata config loading. Both _prLoaded and _configLoaded must
        // be true before handleSave is allowed to create a new PR (isPrReady).
        // Gating here caused the wire to be suppressed on first load,
        // then when config arrived the wire re-fired but _prLoaded was already
        // flagged true from an earlier partial response → activePrId stayed null.
        return {
            userId: USER_ID,
            shipmentType: this._shipmentTypeForTab(this.activeTab)
        };
    }

    @wire(graphql, { query: GET_DRAFT_PR_QUERY, variables: '$draftPrVariables' })
    wiredDraftPR(value) {
        this._draftPrWire = value;
        const { data, errors } = value || {};
        if (data === undefined && errors === undefined) return;

        if (errors) {
            console.error('❌ Draft PR wire error:', JSON.stringify(errors));
            this._prLoaded  = true;
            this.activePrId     = null;
            this.activePrStatus = null;
            this._tryFinishLoading();
            return;
        }

        if (data) {
            // FIX 5: If config is not ready yet, cache the wire data and
            // defer processing. wiredPrConfig will call _processDraftPrData()
            // once the metadata is loaded. This prevents statusDefault /
            // statusShipped from throwing before config arrives.
            if (!this.isConfigReady) {
                console.log('⏳ PR wire fired before config ready — caching for deferred processing');
                this._pendingPrWireData = data;
                // Still mark _prLoaded = false so _tryFinishLoading waits
                // — will be set true inside _processDraftPrData() below
                return;
            }
            this._processDraftPrData(data);
        }
    }

    // FIX 2 / FIX 5: Central processor for PR wire data.
    // Called from wiredDraftPR (when config already ready)
    // OR from wiredPrConfig (when cached data was waiting for config).
    _processDraftPrData(data) {
        this._prLoaded = true;
        this._pendingPrWireData = null; // clear cache

        const edges = data?.uiapi?.query?.ProductRequest?.edges || [];
        console.log('🔍 PR QUERY RESULT — edges:', edges.length, JSON.stringify(edges));
        const existingPr = edges.length > 0 ? edges[0]?.node : null;

        const isScheduled = this.isScheduledTab;

        // Helper: write result into the correct tab's state slots
        const applyTabFields = (nextId, nextStatus, nextNumber, nextNeedByDate) => {
            if (isScheduled) {
                this.activeScheduledPrId     = nextId;
                this.activeScheduledPrStatus = nextStatus;
                this.activeScheduledPrNumber = nextNumber;
                this.scheduledNeedByDate     = nextNeedByDate;
            } else {
                this.activeUnscheduledPrId     = nextId;
                this.activeUnscheduledPrStatus = nextStatus;
                this.activeUnscheduledPrNumber = nextNumber;
                this.unscheduledNeedByDate     = nextNeedByDate;
            }
        };

        if (existingPr) {
            const shippedStatus   = this.statusShipped;
            const submitStatus    = this.statusSubmit;
            const defaultStatus   = this.statusDefault;
            const statusValue     = existingPr?.Status?.value || defaultStatus;
            const needByDateValue = existingPr?.NeedByDate?.value || '';

            console.log('PR FOUND:', existingPr?.Id, '|', statusValue, '| tab:', isScheduled ? 'Scheduled' : 'Unscheduled');

            if (statusValue === shippedStatus) {
                // Shipped → treat as no active PR → user can create a new one
                applyTabFields(null, defaultStatus, '', '');
                console.log('⚠️ PR is Shipped — resetting so new PR can be created');

            } else if (!isScheduled && statusValue === submitStatus) {
                // FIX 1: Unscheduled + Submitted → treat as no active PR.
                // After user submits an Unscheduled PR, the wire re-fires and
                // finds the Submitted PR. Without this check, it was restored
                // into activePrId → blocking new PR creation until Shipped.
                // Now we reset so the user can immediately create a new PR.
                applyTabFields(null, defaultStatus, '', '');
                console.log('⚠️ Unscheduled PR is Submitted — resetting so new PR can be created immediately');

            } else {
                // Active PR found — set activePrId (the ONLY place this is set from wire)
                const nextId     = existingPr.Id;
                const nextNumber = existingPr?.ProductRequestNumber?.value || '';
                applyTabFields(nextId, statusValue, nextNumber, needByDateValue);
                console.log('✅ Existing PR loaded:', nextId, '| Status:', statusValue);
            }
        } else {
            // No PR found for this user + shipmentType → start fresh
            applyTabFields(null, this.statusDefault, '', '');
            console.log('ℹ️ No existing PR for this user + shipmentType.');
        }

        // Push tab-slot state into active properties
        this._applyActiveTabState();
        this._tryFinishLoading();
    }

    get hasActivePrInfo() {
        return !!(this.activePrNumber || this.activePrStatus);
    }

    get activePrInfoLabel() {
        const number = this.activePrNumber || '—';
        const status = this.activePrStatus || '—';
        return `Product Request: ${number} | Status: ${status}`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 3 — All Resource Products (no variables needed)
    // Filtered client-side by serviceResourceId after SR wire resolves
    // ──────────────────────────���──────────────────────────────────────────
    @wire(graphql, { query: GET_RESOURCE_PRODUCTS_QUERY })
    wiredResourceProducts({ data, errors }) {
        if (data === undefined && errors === undefined) return;

        this._rpLoaded = true;

        if (errors) {
            console.error('❌ Resource Products wire error:', JSON.stringify(errors));
            this._rpEdgesAll = [];
            this._tryFinishLoading();
            return;
        }

        if (data) {
            this._rpEdgesAll = data?.uiapi?.query?.DTVSCM_Resource_Product__c?.edges || [];
            console.log('✅ Resource Products fetched (all):', this._rpEdgesAll.length);
            this._tryBuildProducts();
            this._tryFinishLoading();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 4 — PRLIs for active Draft PR
    //
    // Reactive: re-fires when activePrId changes
    // Returns undefined variables when no PR → wire won't fire
    // ─────────────────────────────────────────────────────────────────────
    get prliQueryVariables() {
        if (!this.activePrId) return undefined;
        return { prId: this.activePrId };
    }

    @wire(graphql, { query: GET_PRLI_QUERY, variables: '$prliQueryVariables' })
    wiredPrli(value) {
        this._prliWire = value;
        const { data, errors } = value || {};
        if (data === undefined && errors === undefined) return;

        if (errors) {
            console.error('❌ PRLI wire error:', JSON.stringify(errors));
            this.prliLoaded = true;
            return;
        }

        if (data) {
            const edges = data?.uiapi?.query?.ProductRequestLineItem?.edges || [];
            const map = new Map();
            const qtyMap = new Map();

            for (const e of edges) {
                const p2id = e?.node?.Product2Id?.value;
                const rid  = e?.node?.Id;
                const qty  = e?.node?.QuantityRequested?.value;
                if (p2id && rid) {
                    map.set(p2id, rid);
                    if (qty !== null && qty !== undefined) {
                        qtyMap.set(p2id, Number(qty));
                    }
                }
            }

            this.prliMap    = map;
            this.prliQtyMap = qtyMap;
            this.prliLoaded = true;
            console.log('✅ PRLI map loaded:', map.size, 'entries');

            this._applySavedSnapshotIfOffline();

            // Apply saved selections to UI
            this._applySelectionsFromPrliMap();
            this._applyQuantitiesFromPrliMap();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Build product list once BOTH SR + RP wires have resolved
    // Client-side filter: only show Resource Products matching the
    // running user's ServiceResource
    // ──────────────────────────────────────────────────────���──────────────
    _tryBuildProducts() {
        // Need both SR resolved and RP edges loaded
        if (!this._srLoaded || !this._rpLoaded) return;
        if (!this.serviceResourceId) {
            console.warn('⚠️ No ServiceResource — cannot filter Resource Products');
            this.allProducts = [];
            this.unscheduledProducts = [];
            return;
        }

        // Filter by ServiceResource
        const rpEdges = this._rpEdgesAll.filter(e =>
            e?.node?.DTVSCM_ServiceResource__c?.value === this.serviceResourceId
        );

        if (rpEdges.length === 0) {
            console.warn('⚠️ No Resource Products for this ServiceResource');
            this.allProducts = [];
            this.unscheduledProducts = [];
            return;
        }

        const baseProducts = rpEdges.map(edge => {
            const node     = edge.node;
            const product2 = node.DTVSCM_Product__r;

            const rawQty = node.DTVSCM_Default_Quantity__c?.value;
            const defaultQuantity = (rawQty !== null && rawQty !== undefined && Number(rawQty) > 0)
                ? Number(rawQty)
                : 1;

            return {
                id:              node.Id,
                product2Id:      product2?.Id || null,
                name:            product2?.Name?.value || node?.Name?.value || '—',
                description:     product2?.Description?.value || '—',
                productCode:     product2?.ProductCode?.value || '—',
                defaultQuantity: defaultQuantity,
                selected:        false,
                rowClass:        'product-row'
            };
        });

        // ───────── Scheduled Logic ─────────
        this.allProducts = baseProducts;

        // ───────── Unscheduled Logic ─────────
        // Initial state: qty = defaultQuantity (display value), selected = false.
        // FIX 2: Do NOT pre-select all products — defaultQuantity is for display only.
        // Selection happens ONLY when user interacts (+/-/input) or when a saved
        // PRLI is restored from the server via _applyQuantitiesFromPrliMap().
        this.unscheduledProducts = baseProducts.map(p => ({
            ...p,
            qty:            p.defaultQuantity, // shown in input; not a selection trigger
            isUserModified: false,             // user has not interacted yet
            selected:       false,             // not selected until user clicks row or edits qty
            rowClass:       'product-row'
        }));

        console.log('✅ Products built:', this.allProducts.length);

        if (this.prliLoaded && this.activePrId) {
            this._applySelectionsFromPrliMap();
            this._applyQuantitiesFromPrliMap();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Turn off loading spinner once all 3 main wires have resolved
    //
    // FIX 7: _prLoaded is set inside _processDraftPrData which requires
    // config to be ready. If config loads after the PR wire fires, and
    // _processDraftPrData processes the data, _prLoaded is set and
    // _tryFinishLoading is called again from there — so we will always
    // eventually reach the end state. No change needed to the condition.
    // ─────────────────────────────────────────────────────────────────────
    _tryFinishLoading() {
        if (this._srLoaded && this._prLoaded && this._rpLoaded) {
            this.isLoading = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Apply saved PRLI selections to UI
    // ─────────────────────────────────────────────────────────────────────
    _applySelectionsFromPrliMap() {
        if (this.allProducts.length === 0) return;

        this.allProducts = this.allProducts.map(p => {
            const sel = p.product2Id && this.prliMap.has(p.product2Id);
            return {
                ...p,
                selected: !!sel,
                rowClass: sel ? 'product-row selected' : 'product-row'
            };
        });

        console.log('✅ Selections applied. Selected:',
            this.allProducts.filter(p => p.selected).length
        );
    }

    // ───────── Unscheduled Logic ─────────
    // Apply saved PRLI selections and quantities to the unscheduled list
    _applyQuantitiesFromPrliMap() {
        if (this.unscheduledProducts.length === 0) return;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            const hasPrli = p.product2Id && this.prliMap.has(p.product2Id);

            // Saved PRLI exists → restore saved qty from server.
            // No PRLI → show defaultQuantity in input (display only, not selected).
            const qty = hasPrli
                ? (this.prliQtyMap.get(p.product2Id) || 0)
                : p.defaultQuantity;
            const nextQty  = Number(qty) || 0;

            // FIX 3: selected = hasPrli AND qty > 0.
            // Products WITHOUT a saved PRLI: selected = false (defaultQuantity is display only).
            // Products WITH a saved PRLI: selected = savedQty > 0 (user previously saved this).
            // This prevents auto-selection of all products on every _refreshPrData call.
            const nextSelected = hasPrli && nextQty > 0;

            return {
                ...p,
                qty:            nextQty,
                isUserModified: nextSelected, // true = was previously saved → treat as user action
                selected:       nextSelected,
                rowClass:       nextSelected ? 'product-row selected' : 'product-row'
            };
        });

        console.log('✅ Unscheduled quantities applied.');
    }

    // ── Filtered list ─────────────────────────────────────────────────────
    get filteredProducts() {
        if (!this.searchTerm) return this.allProducts;
        const term = this.searchTerm.toLowerCase();
        return this.allProducts.filter(p =>
            p.name.toLowerCase().includes(term) ||
            p.productCode.toLowerCase().includes(term)
        );
    }
    get hasFilteredProducts() { return this.filteredProducts.length > 0; }

    // ── Toggle selection ──────────────────────────────────────────────────
    // Scheduled Tab Logic (existing — no changes)
    handleProductToggle(event) {
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        this.allProducts = this.allProducts.map(p => {
            if (p.id !== productId) return p;
            const nowSelected = !p.selected;
            return {
                ...p,
                selected: nowSelected,
                rowClass: nowSelected ? 'product-row selected' : 'product-row'
            };
        });
    }

    get selectedProducts()  { return this.allProducts.filter(p => p.selected); }
    get hasSelections()     { return this.selectedProducts.length > 0; }
    get selectedCount()     { return this.selectedProducts.length; }
    get isActionsDisabled() { return this.isSubmitted || !this.hasSelections; }

    // isSubmitted drives UI lock:
    //   Scheduled: locked when status = statusSubmit
    //   Unscheduled: NEVER locked — submit clears activePrId so user can
    //   immediately start a new Unscheduled PR without any restriction
    get isSubmitted() {
        if (this.isUnscheduledTab) {
            // Unscheduled tab is never locked — see handleSubmit for reset logic
            return false;
        }
        return this.isConfigReady && this.activePrStatus === this.statusSubmit;
    }

    // ───────── Unscheduled Logic ─────────
    // Unscheduled Tab Logic (+ / - quantity handling)
    get hasUnscheduledProducts() { return this.unscheduledProducts.length > 0; }
    get filteredUnscheduledProducts() {
        if (!this.searchTerm) return this.unscheduledProducts;
        const term = this.searchTerm.toLowerCase();
        return this.unscheduledProducts.filter(p =>
            p.name.toLowerCase().includes(term) ||
            p.productCode.toLowerCase().includes(term)
        );
    }
    get hasFilteredUnscheduledProducts() { return this.filteredUnscheduledProducts.length > 0; }

    handleUnscheduledToggle(event) {
        if (this.isSubmitted) return;

        const productId = event.currentTarget.dataset.productid;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;

            const nextSelected = !p.selected;

            // When deselecting: keep qty intact so the input value stays visible.
            // Setting qty to 0 on deselect caused the input to blank out — bad UX.
            // The sync logic uses selected flag to decide whether to create/delete PRLI.
            // When selecting: keep current qty (or defaultQuantity as starting value).
            const nextQty = nextSelected
                ? (p.qty > 0 ? p.qty : p.defaultQuantity)
                : p.qty; // preserve qty on deselect — input stays readable

            return {
                ...p,
                qty:            nextQty,
                selected:       nextSelected,
                isUserModified: true,
                rowClass:       nextSelected ? 'product-row selected' : 'product-row'
            };
        });
    }

    handleQtyInput(event) {
        event.stopPropagation();
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        const rawValue  = event.target.value;
        const nextValue = Number(rawValue);

        if (isNaN(nextValue) || nextValue < 0) return;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;
            // Mark as user-modified — now this product can be selected
            const nextModified = true;
            const nextSelected = nextValue > 0;
            // Track pending qty change — written to Resource Product on Save only
            this._pendingQtyChanges.set(p.id, nextValue);
            return {
                ...p,
                qty:            nextValue,
                isUserModified: nextModified,
                selected:       nextSelected,
                rowClass:       nextSelected ? 'product-row selected' : 'product-row'
            };
        });
    }

    handleQtyClick(event) {
        event.stopPropagation();
    }

    handleQtyIncrement(event) {
        event.stopPropagation();
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;
            // Increment from current qty — works even if product not yet selected.
            // selected = qty > 0 (always true after increment since min result is 1).
            const nextValue    = Number(p.qty || 0) + 1;
            const nextSelected = nextValue > 0;
            this._pendingQtyChanges.set(p.id, nextValue);
            return {
                ...p,
                qty:            nextValue,
                isUserModified: true,
                selected:       nextSelected,
                rowClass:       nextSelected ? 'product-row selected' : 'product-row'
            };
        });
    }

    handleQtyDecrement(event) {
        event.stopPropagation();
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;
            // Decrement from current qty — selected = qty > 0.
            // When qty reaches 0 → selected becomes false automatically.
            const next         = Math.max(0, Number(p.qty || 0) - 1);
            const nextSelected = next > 0;
            this._pendingQtyChanges.set(p.id, next);
            return {
                ...p,
                qty:            next,
                isUserModified: true,
                selected:       nextSelected,
                rowClass:       nextSelected ? 'product-row selected' : 'product-row'
            };
        });
    }


    // ───────── Shared Logic ─────────
    handleNeedByDateChange(event) {
        const value = event.target.value;

        // Convert YYYY-MM-DD → ISO format
        this.needByDate = value
            ? new Date(value + 'T00:00:00.000Z').toISOString()
            : null;
    }

    // ── Clear ─────────────────────────────────────────────────────────────
    handleClear() {
        this.allProducts = this.allProducts.map(p => ({
            ...p, selected: false, rowClass: 'product-row'
        }));
    }

    _savedSnapshotKey() {
        return `dtvscm_prli_saved_${USER_ID}`;
    }

    _loadSavedSnapshot() {
        try {
            const raw = localStorage.getItem(this._savedSnapshotKey());
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('⚠️ Saved snapshot load failed:', e);
            return null;
        }
    }

    _saveSavedSnapshot() {
        if (!this.activePrId) return;
        const payload = {
            prId: this.activePrId,
            map: [...this.prliMap.entries()],
            qtyMap: [...this.prliQtyMap.entries()],
            ts: Date.now()
        };
        try {
            localStorage.setItem(this._savedSnapshotKey(), JSON.stringify(payload));
        } catch (e) {
            console.warn('⚠️ Saved snapshot write failed:', e);
        }
    }

    _applySavedSnapshotIfOffline() {
        if (this.isOnline) return;
        const snapshot = this._loadSavedSnapshot();
        if (!snapshot || snapshot.prId !== this.activePrId) return;
        this.prliMap = new Map(snapshot.map || []);
        this.prliQtyMap = new Map(snapshot.qtyMap || []);
    }

    // ─────────────────────────────────────────────────────────────────────
    // SAVE — ensure PR exists, then delta-sync PRLIs to match UI
    //
    // Step 1: If no activePrId → createRecord(ProductRequest)
    // Step 2: Compare UI selections vs prliMap (server truth)
    // Step 3: Create missing PRLIs, delete removed PRLIs
    // ─────────────────────────────────────────────────────────────────────
    @track isSaving = false;

    // Shared Save / Submit Logic
    async handleSave() {
        if (!this._ensureConfigReady()) return;
        if (this.isSubmitted) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Request Submitted',
                message: 'This Product Request is submitted and can no longer be edited.',
                variant: 'info'
            }));
            return;
        }
        if (!this.isPrReady) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Please wait',
                message: 'Loading existing Product Request...',
                variant: 'info'
            }));
            return;
        }

        // ── Unscheduled: zero-qty guard ──────────────────────────────────
        // Block Save / Submit if no product has qty > 0 in Unscheduled tab.
        // This check runs before any PR or PRLI creation attempt.
        if (this.isUnscheduledTab) {
            // Guard: at least one product must have qty > 0 to proceed with Save/Submit.
            // Guard: check qty > 0 only — not p.selected.
            // selected=false with qty>0 is valid (user typed qty but didn't tap row).
            const hasAnyUserQty = this.unscheduledProducts.some(
                p => p.product2Id && Number(p.qty || 0) > 0
            );
            if (!hasAnyUserQty) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Quantity Required',
                    message: 'Please select at least 1 quantity for a product.',
                    variant: 'warning'
                }));
                return;
            }
        }

        this.isSaving = true;

        try {
            // ── STEP 1: Ensure ProductRequest exists ──────────────────────
            if (!this.activePrId && this._prLoaded) {
                const prFields = {};
                prFields[PR_STATUS.fieldApiName]      = this.statusDefault;
                prFields[PR_DESCRIPTION.fieldApiName] = `Product Request — ${new Date().toLocaleDateString()}`;
                prFields[PR_SHIPMENT_TYPE.fieldApiName] = this._shipmentTypeForTab(this.activeTab);
                if (this.isUnscheduledTab && this.needByDate) {
                    prFields[PR_NEED_BY_DATE.fieldApiName] = this.needByDate;
                }

                console.log('⚡ Creating ProductRequest...');
                const prResult = await createRecord({
                    apiName: PR_OBJECT.objectApiName,
                    fields: prFields
                });
                this.activePrId     = prResult.id;
                this.activePrStatus = this.statusDefault;
                console.log('✅ ProductRequest created:', this.activePrId);
                this._storeActiveTabState();
                await this._refreshPrData();
            } else if (this.isUnscheduledTab && this.needByDate !== undefined) {
                const prUpdateFields = {};
                prUpdateFields[PR_ID.fieldApiName] = this.activePrId;
                prUpdateFields[PR_NEED_BY_DATE.fieldApiName] = this.needByDate || null;
                await updateRecord({ fields: prUpdateFields });
            }

            // ───────── Scheduled Logic ─────────
            // Preserve selection-based behavior for Scheduled tab
            let createErrors = [];
            let updateErrors = [];
            let deleteErrors = [];
            let delta = { created: 0, updated: 0, deleted: 0 };

            if (this.isScheduledTab) {
                const result = await this._syncScheduledSelections();
                createErrors = result.createErrors;
                deleteErrors = result.deleteErrors;
                delta = result.delta;
            }

            // ───────── Unscheduled Logic ─────────
            // Quantity-based behavior for Unscheduled tab
            if (this.isUnscheduledTab) {
                const result = await this._syncUnscheduledSelections();
                createErrors = result.createErrors;
                updateErrors = result.updateErrors;
                deleteErrors = result.deleteErrors;
                delta = result.delta;

                // After PRLI sync succeeds, write pending qty changes to
                // Resource Product.DTVSCM_Default_Quantity__c.
                // This is only triggered on Save — unsaved changes are discarded.
                if (createErrors.length === 0 && updateErrors.length === 0 && deleteErrors.length === 0) {
                    await this._flushPendingQtyChanges();
                }
            }

            const hasSaveErrors = createErrors.length > 0 || updateErrors.length > 0 || deleteErrors.length > 0;
            if (!hasSaveErrors) {
                this._saveSavedSnapshot();
            }

            // ── STEP 4: Refresh PR + PRLI wires so UI reflects saved state
            await this._refreshPrData();
            await new Promise(resolve => setTimeout(resolve, 300));

            this._applySavedSnapshotIfOffline();
            this._applySelectionsFromPrliMap();
            this._applyQuantitiesFromPrliMap();

            // ── STEP 5: Toast ─────────────────────────────────────────────
            if (!hasSaveErrors) {
                this.dispatchEvent(new ShowToastEvent({
                    title: '✅ Saved',
                    message: `Draft saved — ${delta.created} added, ${delta.updated} updated, ${delta.deleted} removed.`,
                    variant: 'success'
                }));
            } else {
                const msg = [...createErrors, ...updateErrors, ...deleteErrors].join(' | ');
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Saved with Issues',
                    message: msg,
                    variant: 'warning', mode: 'sticky'
                }));
            }

        } catch (err) {
            console.error('❌ Save failed:', err);
            this.dispatchEvent(new ShowToastEvent({
                title: 'Save Failed',
                message: err?.body?.message || err.message,
                variant: 'error', mode: 'sticky'
            }));
        } finally {
            this.isSaving = false;
        }
    }

    // ───────── Scheduled Logic ─────────
    async _syncScheduledSelections() {
        // Step 2: Compute delta between UI and server
        const existingMap = this.prliMap;          // Map(Product2Id → PRLI.Id)
        const existingIds = new Set(existingMap.keys());

        const selected    = this.selectedProducts;
        const selectedP2Ids = new Set(selected.map(p => p.product2Id).filter(Boolean));

        // Products selected in UI but NOT yet on server → need createRecord
        const toCreate = [...selectedP2Ids].filter(pid => !existingIds.has(pid));
        // Products on server but NOT selected in UI → need deleteRecord
        const toDelete = [...existingIds].filter(pid => !selectedP2Ids.has(pid));

        console.log(`📊 Save delta — Create: ${toCreate.length}, Delete: ${toDelete.length}`);

        const createErrors = [];
        for (const pid of toCreate) {
            const p = selected.find(x => x.product2Id === pid);
            if (!p) continue;
            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = (p.defaultQuantity && Number(p.defaultQuantity) > 0)
                    ? Number(p.defaultQuantity) : 1;

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.defaultQuantity})`);
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);

                this.prliMap.set(pid, prliResult.id);
                this.prliQtyMap.set(pid, prliFields[PRLI_QTY_REQUESTED.fieldApiName]);
            } catch (e) {
                console.error(`❌ PRLI create failed: ${p.name}`, e);
                createErrors.push(`${p.name}: ${e?.body?.message || e.message}`);
            }
        }

        const deleteErrors = [];
        for (const pid of toDelete) {
            try {
                const recId = existingMap.get(pid);
                if (recId) {
                    console.log(`🗑️ Deleting PRLI for Product2Id: ${pid} (${recId})`);
                    await deleteRecord(recId);
                    this.prliMap.delete(pid);
                    this.prliQtyMap.delete(pid);
                }
            } catch (e) {
                console.error(`❌ PRLI delete failed: ${pid}`, e);
                deleteErrors.push(`Delete ${pid}: ${e?.body?.message || e.message}`);
            }
        }

        return {
            createErrors,
            deleteErrors,
            delta: { created: toCreate.length, updated: 0, deleted: toDelete.length }
        };
    }

    // ───────── Unscheduled Logic ─────────
    async _syncUnscheduledSelections() {
        const existingMap = this.prliMap;      // Map(Product2Id → PRLI.Id)
        const existingQty = this.prliQtyMap;   // Map(Product2Id → Quantity)
        const existingIds = new Set(existingMap.keys());

        // Include all products with qty > 0 — qty is the single source of truth.
        // Not filtering by p.selected avoids any qty/selected mismatch causing silent skips.
        const selected = this.unscheduledProducts
            .filter(p => p.product2Id && Number(p.qty || 0) > 0)
            .map(p => ({ ...p, qty: Math.max(0, Number(p.qty || 0)) }));

        const selectedIds = new Set(selected.map(p => p.product2Id));

        const toCreate = [...selectedIds].filter(pid => !existingIds.has(pid));
        const toDelete = [...existingIds].filter(pid => !selectedIds.has(pid));
        const toUpdate = selected
            .filter(p => existingIds.has(p.product2Id))
            .filter(p => Number(existingQty.get(p.product2Id)) !== p.qty)
            .map(p => p.product2Id);

        console.log(`📊 Save delta — Create: ${toCreate.length}, Update: ${toUpdate.length}, Delete: ${toDelete.length}`);

        const createErrors = [];
        for (const pid of toCreate) {
            const p = selected.find(x => x.product2Id === pid);
            if (!p) continue;
            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = p.qty;

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.qty})`);
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);

                this.prliMap.set(pid, prliResult.id);
                this.prliQtyMap.set(pid, p.qty);
            } catch (e) {
                console.error(`❌ PRLI create failed: ${p.name}`, e);
                createErrors.push(`${p.name}: ${e?.body?.message || e.message}`);
            }
        }

        const updateErrors = [];
        for (const pid of toUpdate) {
            const p = selected.find(x => x.product2Id === pid);
            if (!p) continue;
            try {
                const prliFields = {};
                prliFields.Id = existingMap.get(pid);
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = p.qty;

                console.log(`✏️ Updating PRLI: ${p.name} (qty: ${p.qty})`);
                await updateRecord({ fields: prliFields });
                this.prliQtyMap.set(pid, p.qty);
            } catch (e) {
                console.error(`❌ PRLI update failed: ${p.name}`, e);
                updateErrors.push(`${p.name}: ${e?.body?.message || e.message}`);
            }
        }

        const deleteErrors = [];
        for (const pid of toDelete) {
            try {
                const recId = existingMap.get(pid);
                if (recId) {
                    console.log(`🗑️ Deleting PRLI for Product2Id: ${pid} (${recId})`);
                    await deleteRecord(recId);
                    this.prliMap.delete(pid);
                    this.prliQtyMap.delete(pid);
                }
            } catch (e) {
                console.error(`❌ PRLI delete failed: ${pid}`, e);
                deleteErrors.push(`Delete ${pid}: ${e?.body?.message || e.message}`);
            }
        }

        return {
            createErrors,
            updateErrors,
            deleteErrors,
            delta: { created: toCreate.length, updated: toUpdate.length, deleted: toDelete.length }
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    // _flushPendingQtyChanges (Unscheduled only)
    //
    // Writes user qty changes to DTVSCM_Resource_Product__c.DTVSCM_Default_Quantity__c
    // ONLY after Save is clicked and PRLI sync succeeded.
    //
    // _pendingQtyChanges: Map(resourceProductId → newQty)
    //   Populated by handleQtyInput / handleQtyIncrement / handleQtyDecrement
    //   Cleared here after successful write — or on discard (tab switch / back)
    //
    // If user changed qty but did NOT click Save → changes are discarded
    // because _pendingQtyChanges is never flushed.
    // ─────────────────────────────────────────────────────────────────────
    async _flushPendingQtyChanges() {
        if (this._pendingQtyChanges.size === 0) return;

        const flushErrors = [];

        for (const [rpId, newQty] of this._pendingQtyChanges.entries()) {
            try {
                const fields = {};
                fields[RP_ID.fieldApiName]          = rpId;
                fields[RP_DEFAULT_QTY.fieldApiName] = newQty;

                console.log(`✏️ Updating ResourceProduct default qty: ${rpId} → ${newQty}`);
                await updateRecord({ fields });
                console.log(`✅ ResourceProduct qty updated: ${rpId}`);
            } catch (e) {
                console.error(`❌ ResourceProduct qty update failed: ${rpId}`, e);
                flushErrors.push(`ResourceProduct ${rpId}: ${e?.body?.message || e.message}`);
            }
        }

        // Always clear the pending map after flush attempt
        // (even on partial failure — prevents re-applying stale changes)
        this._pendingQtyChanges = new Map();

        if (flushErrors.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Default Qty Update Issues',
                message: flushErrors.join(' | '),
                variant: 'warning', mode: 'sticky'
            }));
        } else {
            console.log('✅ All pending qty changes flushed to Resource Products');
        }
    }

    async _refreshPrData() {
        const refreshes = [];
        if (this._draftPrWire) refreshes.push(refreshGraphQL(this._draftPrWire));
        if (this._prliWire) refreshes.push(refreshGraphQL(this._prliWire));
        if (refreshes.length === 0) return;

        try {
            await Promise.all(refreshes);
        } catch (err) {
            console.warn('⚠️ Refresh failed:', err);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SUBMIT — save delta first, then update PR.Status = 'Submitted'
    //
    // SCHEDULED tab:
    //   - Standard flow: Save → Submit → lock form (existing behavior)
    //
    // UNSCHEDULED tab:
    //   - Save → Submit → reset activePrId to null → form UNLOCKS
    //   - User can immediately start a new Unscheduled PR after submitting
    //   - isSubmitted getter always returns false for Unscheduled tab
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        if (!this._ensureConfigReady()) return;
        if (this.isSubmitted) {
            // Only reaches here for Scheduled tab (isSubmitted is always false for Unscheduled)
            this.dispatchEvent(new ShowToastEvent({
                title: 'Already Submitted',
                message: 'This Product Request is already submitted.',
                variant: 'info'
            }));
            return;
        }

        // Save first to sync PRLIs (also runs zero-qty guard for Unscheduled)
        await this.handleSave();

        if (!this.activePrId) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Submit Blocked',
                message: 'Could not create Product Request.',
                variant: 'error'
            }));
            return;
        }

        try {
            const fields = {};
            fields[PR_ID.fieldApiName]     = this.activePrId;
            fields[PR_STATUS.fieldApiName] = this.statusSubmit;

            console.log('⚡ Submitting PR:', this.activePrId);
            await updateRecord({ fields });
            console.log('✅ PR submitted');

            if (this.isUnscheduledTab) {
                // ── UNSCHEDULED: reset state so user can create a new PR ──────
                // Do NOT lock the form — isSubmitted always returns false here.
                // Reset activePrId + tab-cached slots → next Save creates a fresh PR.
                // Reset all qty values back to defaultQuantity so the list is clean.
                const submittedId = this.activePrId;
                this.activePrId              = null;
                this.activePrStatus          = null;
                this.activePrNumber          = '';
                this.activeUnscheduledPrId     = null;
                this.activeUnscheduledPrStatus = null;
                this.activeUnscheduledPrNumber = '';
                this.unscheduledNeedByDate     = '';
                this.needByDate               = '';
                this.prliMap                  = new Map();
                this.prliQtyMap               = new Map();
                this._pendingQtyChanges       = new Map();

                // Reset to clean slate — matches initial build state.
                // qty = defaultQuantity for display; selected = false until user acts.
                this.unscheduledProducts = this.unscheduledProducts.map(p => ({
                    ...p,
                    qty:            p.defaultQuantity,
                    isUserModified: false,
                    selected:       false,
                    rowClass:       'product-row'
                }));

                // Force wire to re-evaluate. With FIX 1 in _processDraftPrData,
                // the now-Submitted PR will be ignored → activePrId stays null
                // → user can immediately create a new Unscheduled PR.
                this._prLoaded = false;
                await this._refreshPrData();

                console.log('✅ Unscheduled PR submitted:', submittedId, '— form reset for new PR');

                this.dispatchEvent(new ShowToastEvent({
                    title: '✅ Submitted',
                    message: 'Product Request submitted. You can now create a new Unscheduled request.',
                    variant: 'success'
                }));

            } else {
                // ── SCHEDULED: lock UI as before ──────────────────────────────
                this.activePrStatus = this.statusSubmit;

                this.allProducts = this.allProducts.map(p => ({
                    ...p,
                    rowClass: p.selected ? 'product-row selected' : 'product-row'
                }));

                this.dispatchEvent(new ShowToastEvent({
                    title: '✅ Submitted',
                    message: 'Product Request submitted successfully.',
                    variant: 'success'
                }));
            }

        } catch (e) {
            console.error('❌ Submit failed:', e);
            this.dispatchEvent(new ShowToastEvent({
                title: 'Submit Failed',
                message: e?.body?.message || e.message,
                variant: 'error', mode: 'sticky'
            }));
        }
    }

    // ── Sync queue (offline) ──────────────────────────────────────────────
    async handleSyncQueue() {
        if (!this._ensureConfigReady()) return;
        if (!this.isOnline || this.offlineQueue.length === 0) return;
        this.isSyncing = true;
        const queue   = [...this.offlineQueue];
        let   success = 0;
        const failed  = [];

        for (const op of queue) {
            try {
                await this._createPRAndLineItems(op.items, true);
                this.offlineQueue = this.offlineQueue.filter(q => q.id !== op.id);
                success++;
            } catch (err) {
                failed.push(`${op.items.length} item(s) @ ${new Date(op.timestamp).toLocaleTimeString()}`);
            }
        }
        this.isSyncing = false;
        this.dispatchEvent(new ShowToastEvent(
            failed.length === 0
                ? { title: '✅ Sync Complete', message: `${success} PR(s) created.`, variant: 'success' }
                : { title: 'Sync Partial', message: `${success} ok. Failed: ${failed.join(', ')}`, variant: 'error', mode: 'sticky' }
        ));
    }

    // Legacy create-all for offline queue
    async _createPRAndLineItems(items, silent = false) {
        if (!this._ensureConfigReady()) return;
        const prFields = {};
        prFields[PR_STATUS.fieldApiName]      = this.statusDefault;
        prFields[PR_DESCRIPTION.fieldApiName] = `Product Request — ${items.length} item(s) — ${new Date().toLocaleDateString()}`;

        const prResult = await createRecord({ apiName: PR_OBJECT.objectApiName, fields: prFields });
        const prId     = prResult.id;

        let prliCount    = 0;
        const prliErrors = [];

        for (const item of items) {
            try {
                if (!item.product2Id) throw new Error(`No Product2Id for: ${item.name}`);
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = prId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = item.product2Id;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = item.defaultQuantity || 1;
                await createRecord({ apiName: PRLI_OBJECT.objectApiName, fields: prliFields });
                prliCount++;
            } catch (prliErr) {
                prliErrors.push(`${item.name}: ${prliErr?.body?.message || prliErr.message}`);
            }
        }

        if (prliErrors.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Some Line Items Failed', message: prliErrors.join(' | '),
                variant: 'error', mode: 'sticky'
            }));
        }

        if (!silent) {
            this.dispatchEvent(new ShowToastEvent({
                title: '✅ Request Created!',
                message: `Product Request with ${prliCount} line item(s).`,
                variant: 'success'
            }));
            this.handleClear();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire — PR Config from Custom Metadata (GraphQL)
    // Maps DeveloperName to local config properties
    // ─────────────────────────────────────────────────────────────────────
    @wire(graphql, { query: GET_PR_CONFIG_QUERY })
    wiredPrConfig({ data, errors }) {
        if (data === undefined && errors === undefined) return;

        if (errors) {
            console.warn('⚠️ PR Config wire error:', JSON.stringify(errors));
            this._configLoaded = true;
            // If PR wire already instantiated, refresh to allow it to run with defaults
            if (this._draftPrWire) {
                try { refreshGraphQL(this._draftPrWire); } catch (e) {}
            }
            return;
        }
        try {
            const edges = data?.uiapi?.query?.DTV_SCM_Configuration__mdt?.edges || [];
            const map = { ...(this.config || {}) };
            for (const e of edges) {
                const dn = e?.node?.DeveloperName?.value;
                const val = e?.node?.Value__c?.value;
                if (!dn || !val) continue;
                switch (dn) {
                    case 'Default_PR_Status':
                        map.defaultStatus = val;
                        break;
                    case 'Submit_PR_Status':
                        map.submitStatus = val;
                        break;
                    case 'Submit_PR_Shipped':
                        map.shippedStatus = val;
                        break;
                    default:
                        break;
                }
            }
            if (!map.defaultStatus || !map.submitStatus || !map.shippedStatus) {
                console.error('❌ Metadata configuration incomplete');
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Configuration Error',
                    message: 'Product Request Status metadata is not properly configured.',
                    variant: 'error',
                    mode: 'sticky'
                }));
                return;
            }
            this.config = map;
        } finally {
            this._configLoaded = true;

            // FIX 6: If PR wire already fired while config was loading,
            // process its cached data now instead of waiting for a re-fetch.
            if (this._pendingPrWireData) {
                console.log('🔄 Config ready — processing cached PR wire data');
                this._processDraftPrData(this._pendingPrWireData);
            } else if (this._draftPrWire) {
                // No cached data → re-trigger the wire so it re-evaluates
                // draftPrVariables (which no longer returns undefined now).
                try { refreshGraphQL(this._draftPrWire); } catch (e) {}
            }
        }
    }

    _ensureConfigReady() {
        if (this.isConfigReady) return true;
        this.dispatchEvent(new ShowToastEvent({
            title: 'Configuration Error',
            message: 'Product Request Status metadata is not properly configured.',
            variant: 'error',
            mode: 'sticky'
        }));
        return false;
    }
}
