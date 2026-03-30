import { LightningElement, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';

import { gql, graphql, refreshGraphQL } from 'lightning/uiGraphQLApi';
import { createRecord, updateRecord, deleteRecord, notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import USER_ID from '@salesforce/user/Id';

// Apex controller — fetches Custom Metadata for offline-safe caching.
// UI API / GraphQL does NOT support Custom Metadata offline priming.
// @AuraEnabled(cacheable=true) Apex IS supported by offline priming.
import getPrConfig from '@salesforce/apex/DtvscmProductRequestController.getPrConfig';

const FORM_FACTOR_SMALL = 'Small';
const FORM_FACTOR_LARGE = 'Large';

const TAB_SCHEDULED = 'scheduled';
const TAB_UNSCHEDULED = 'unscheduled';

const SHIPMENT_TYPE_SCHEDULED = 'Scheduled';
const SHIPMENT_TYPE_UNSCHEDULED = 'Unscheduled';

// ProductRequest schema tokens
import PR_OBJECT      from '@salesforce/schema/ProductRequest';
import PR_STATUS      from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION from '@salesforce/schema/ProductRequest.Description';
import PR_NEED_BY_DATE from '@salesforce/schema/ProductRequest.NeedByDate';
import PR_ID          from '@salesforce/schema/ProductRequest.Id';
import PR_SHIPMENT_TYPE    from '@salesforce/schema/ProductRequest.ShipmentType';
import PR_SERVICE_RESOURCE from '@salesforce/schema/ProductRequest.DTVSCM_Service_Resource__c';

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
                        node {
                            Id
                            Name                         { value }
                            LocationId                   { value }
                            DTVSCM_Warehouse_Location__c { value }
                        }
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
    query GetDraftPR($serviceResourceId: ID, $shipmentType: Picklist) {
        uiapi {
            query {
                ProductRequest(
                    where: { DTVSCM_Service_Resource__c: { eq: $serviceResourceId }, ShipmentType: { eq: $shipmentType } }
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
                                Name                { value }
                                Description         { value }
                                ProductCode         { value }
                                IsSerialized        { value }
                                IsActive            { value }
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

// Custom Metadata (DTVSCM_Configuration__mdt) is now fetched via Apex
// (DtvscmProductRequestController.getPrConfig) instead of GraphQL/UI API.
// UI API does not support Custom Metadata offline priming/caching.
// Apex @AuraEnabled(cacheable=true) is fully supported for offline use.

export default class Dtvscm_productRequest extends LightningElement {

    // ── formFactor ────────────────────────────────────────────────────────
    get isMobile()  { return FORM_FACTOR === FORM_FACTOR_SMALL; }
    get isDesktop() { return FORM_FACTOR === FORM_FACTOR_LARGE; }

    get todayDate() {
        return new Date().toISOString().split('T')[0];
    }

    get shellClass() {
        return FORM_FACTOR === FORM_FACTOR_SMALL ? 'shell shell-mobile' : 'shell shell-desktop';
    }
    get productListClass() {
        return FORM_FACTOR === FORM_FACTOR_SMALL ? 'product-list' : 'product-list product-list-desktop';
    }
    get bottomBarClass() {
        return FORM_FACTOR === FORM_FACTOR_SMALL ? 'bottom-bar bottom-bar-mobile' : 'bottom-bar bottom-bar-desktop';
    }

    // ── Tab state ─────────────────────────────────────────────────────────
    @track activeTab = TAB_SCHEDULED;

    get isScheduledTab()      { return this.activeTab === TAB_SCHEDULED; }
    get isUnscheduledTab()    { return this.activeTab === TAB_UNSCHEDULED; }
    get scheduledTabClass()   { return this.activeTab === TAB_SCHEDULED   ? 'tab-btn active' : 'tab-btn'; }
    get unscheduledTabClass() { return this.activeTab === TAB_UNSCHEDULED ? 'tab-btn active' : 'tab-btn'; }

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
        return tab === TAB_SCHEDULED ? SHIPMENT_TYPE_SCHEDULED : SHIPMENT_TYPE_UNSCHEDULED;
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
            this.unscheduledOriginalNeedByDate = this.originalNeedByDate;
        }
    }

    _applyActiveTabState() {
        if (this.isScheduledTab) {
            this.activePrId = this.activeScheduledPrId || null;
            this.activePrStatus = this.activeScheduledPrStatus || null;
            this.activePrNumber = this.activeScheduledPrNumber || '';
            this.needByDate = this.scheduledNeedByDate || '';
            this.originalNeedByDate = '';
        } else {
            this.activePrId = this.activeUnscheduledPrId || null;
            this.activePrStatus = this.activeUnscheduledPrStatus || null;
            this.activePrNumber = this.activeUnscheduledPrNumber || '';
            this.needByDate = this.unscheduledNeedByDate || '';
            this.originalNeedByDate = this.unscheduledOriginalNeedByDate || '';
        }

        // Only reset PRLI maps when NOT saving.
        // During save, prliMap/prliQtyMap must remain intact — they are the single
        // source of truth for the sync delta (existingIds). Resetting them here wipes
        // that truth, causing toCreate to include all selected products (duplicates)
        // and toDelete to be empty (deselect not removed).
        // Sync operations maintain the local maps accurately via set/delete calls.
        // STEP 4's explicit _applyQuantitiesFromPrliMap() reconciles from server after save.
        if (!this.isSaving) {
            this.prliMap = new Map();
            this.prliQtyMap = new Map();
            this.prliLoaded = false;
        }

        // Proactive closed-status check: if activePrStatus is already a closed
        // status (from stale GraphQL cache or external update), reset immediately
        // without waiting for wiredDraftPR to re-fire. Fixes mobile offline lock.
        this._checkAndResetIfClosed();

        this._applySelectionsFromPrliMap();
        if (!this.isSaving) {
            this._applyQuantitiesFromPrliMap();
        }
    }

    _resetActivePrStateForOfflineClose() {
        const safeDefault = this.isConfigReady ? this.statusDefault : null;
        if (this.isScheduledTab) {
            this.activeScheduledPrId = null;
            this.activeScheduledPrStatus = safeDefault;
            this.activeScheduledPrNumber = '';
            this.scheduledNeedByDate = '';
        } else {
            this.activeUnscheduledPrId = null;
            this.activeUnscheduledPrStatus = safeDefault;
            this.activeUnscheduledPrNumber = '';
            this.unscheduledNeedByDate = '';
            this.unscheduledOriginalNeedByDate = '';
        }

        this._applyActiveTabState();
    }

    _resetIfClosedStatus(nextStatus) {
        if (nextStatus === this.statusClosedRejected || nextStatus === this.statusClosedFulfilled) {
            this._resetActivePrStateForOfflineClose();
        }
    }

    // _checkAndResetIfClosed — proactive offline-safe closed-status check.
    //
    // Called from _applyActiveTabState so it runs on every state restore
    // (tab switch, load, post-save). If activePrStatus is already a closed
    // status at that point — from stale wire cache or any other source —
    // we immediately reset without waiting for wiredDraftPR to re-fire.
    //
    // This is the core fix for mobile offline/online: the wire may return
    // stale cached data after refreshGraphQL, but by checking activePrStatus
    // eagerly we break that dependency entirely.
    _checkAndResetIfClosed() {
        if (!this.isConfigReady) return;
        if (this._isResettingClosed) return;
        if (this.isScheduledTab &&
            (this.activePrStatus === this.statusClosedRejected ||
             this.activePrStatus === this.statusClosedFulfilled)) {
            console.log('🔄 _checkAndResetIfClosed: Scheduled PR has closed status (' +
                this.activePrStatus + ') — resetting for new PR creation');
            this._isResettingClosed = true;
            try {
                this._resetActivePrStateForOfflineClose();
            } finally {
                this._isResettingClosed = false;
            }
        }
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
    @track originalNeedByDate = '';
    @track isLoading         = true;
    @track hasWireError      = false;
    @track wireErrorMessage  = '';
    @track serviceResourceId      = null;
    @track sourceLocationId       = null; // ServiceResource.DTVSCM_Warehouse_Location__c
    @track destinationLocationId  = null; // ServiceResource.LocationId

    @track activeScheduledPrId = null;
    @track activeUnscheduledPrId = null;
    @track activeScheduledPrStatus = null;
    @track activeUnscheduledPrStatus = null;
    @track activeScheduledPrNumber = '';
    @track activeUnscheduledPrNumber = '';
    @track scheduledNeedByDate = '';
    @track unscheduledNeedByDate = '';
    @track unscheduledOriginalNeedByDate = '';

    _isResettingClosed = false;

    // Reactive refresh trigger for GraphQL wire re-evaluation
    refreshKey = 0;

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
    get statusClosedRejected() {
        if (!this.config?.closedRejectedStatus) {
            throw new Error('Metadata missing: Closed_Rejected_PR_Status');
        }
        return this.config.closedRejectedStatus;
    }
    get statusClosedFulfilled() {
        if (!this.config?.closedFulfilledStatus) {
            throw new Error('Metadata missing: Closed_Fulfilled_PR_Status');
        }
        return this.config.closedFulfilledStatus;
    }

    get isConfigReady() {
        return !!(
            this.config?.defaultStatus &&
            this.config?.submitStatus &&
            this.config?.closedRejectedStatus &&
            this.config?.closedFulfilledStatus
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

    // Cached wire results for refreshGraphQL.
    // Storing all four GraphQL wire results gives _refreshPrData (and any future
    // refresh path) a handle to every query without hunting for them at call time.
    _draftPrWire = null;
    _prliWire    = null;
    _srWire      = null;  // ServiceResource wire
    _rpWire      = null;  // ResourceProducts wire

    // ─────────────────────────────────────────────────────────────────────
    // @wire 1 — ServiceResource for running user
    //
    // Reactive variable: passes USER_ID at runtime (NOT string interpolation)
    // ────────────────────────���────────────────────────────────────────────
    get srVariables() {
        return { userId: USER_ID };
    }

    @wire(graphql, { query: GET_SERVICE_RESOURCE_QUERY, variables: '$srVariables' })
    wiredServiceResource(value) {
        this._srWire = value; // store for refreshGraphQL if needed
        const { data, errors } = value || {};
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
            this.serviceResourceId     = edges.length > 0 ? edges[0]?.node?.Id : null;
            // Location mapping: SourceLocation ← Warehouse; DestinationLocation ← LocationId
            this.sourceLocationId      = edges[0]?.node?.DTVSCM_Warehouse_Location__c?.value || null;
            this.destinationLocationId = edges[0]?.node?.LocationId?.value || null;
            console.log('✅ ServiceResource resolved:', this.serviceResourceId || 'NONE',
                '| srcLoc:', this.sourceLocationId, '| dstLoc:', this.destinationLocationId);
            this._tryBuildProducts();
            this._tryFinishLoading();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 2 — Draft ProductRequest for running user
    // ───────────────────────────────────────────────────────────────���─────
    get draftPrVariables() {
        // Do NOT gate on isConfigReady here (see original comment).
        // Gate on serviceResourceId: if the SR wire hasn't resolved yet,
        // returning undefined suppresses this wire so it doesn't fire with
        // a null ID. It will re-fire automatically once serviceResourceId is set.
        if (!this.serviceResourceId) return undefined;
        return {
            serviceResourceId: this.serviceResourceId,
            shipmentType:      this._shipmentTypeForTab(this.activeTab)
        };
    }

    // Computed variables including refreshKey to force wire re-evaluation
    get computedDraftPrVariables() {
        const base = this.draftPrVariables;
        if (base === undefined) return undefined;
        return { ...base, refreshKey: this.refreshKey };
    }

    @wire(graphql, { query: GET_DRAFT_PR_QUERY, variables: '$computedDraftPrVariables' })
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
            // Skip all processing while a save is in progress.
            // STEP 4 of handleSave calls _refreshPrData() which triggers this wire.
            // Processing mid-save calls _processDraftPrData → _applyActiveTabState,
            // which (even with the prliMap guard) still overwrites activePrId from
            // stale tab-slot data at the wrong time. Skip entirely; the wire will
            // re-fire with fresh data after isSaving=false in the finally block.
            if (this.isSaving) {
                console.log('⏭️ wiredDraftPR skipped — save in progress');
                return;
            }

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
        const applyTabFields = (nextId, nextStatus, nextNumber, nextNeedByDate, nextOriginalNeedByDate) => {
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
                this.unscheduledOriginalNeedByDate = nextOriginalNeedByDate || '';
            }
        };

        if (existingPr) {
            const closedRejectedStatus  = this.statusClosedRejected;
            const closedFulfilledStatus = this.statusClosedFulfilled;
            const submitStatus          = this.statusSubmit;
            const defaultStatus         = this.statusDefault;
            const statusValue           = existingPr?.Status?.value || defaultStatus;
            const rawNeedByDate         = existingPr?.NeedByDate?.value || '';
            const needByDateValue       = rawNeedByDate ? String(rawNeedByDate).split('T')[0] : '';

            console.log('PR FOUND:', existingPr?.Id, '|', statusValue, '| tab:', isScheduled ? 'Scheduled' : 'Unscheduled');

            // Scheduled tab: Closed - Rejected or Closed - Fulfilled both act as
            // terminal statuses that allow a new Product Request to be created.
            // These replace the previous Shipped status check.
            // Unscheduled tab is NOT affected by this block (handled separately below).
            if (isScheduled && (statusValue === closedRejectedStatus || statusValue === closedFulfilledStatus)) {
                applyTabFields(null, defaultStatus, '', '', '');
                console.log('⚠️ Scheduled PR is Closed (' + statusValue + ') — resetting so new PR can be created');

            } else if (!isScheduled && statusValue === submitStatus) {
                // FIX 1: Unscheduled + Submitted → treat as no active PR.
                // After user submits an Unscheduled PR, the wire re-fires and
                // finds the Submitted PR. Without this check, it was restored
                // into activePrId → blocking new PR creation until Shipped.
                // Now we reset so the user can immediately create a new PR.
                applyTabFields(null, defaultStatus, '', '', '');
                console.log('⚠️ Unscheduled PR is Submitted — resetting so new PR can be created immediately');

            } else {
                // Active PR found — set activePrId (the ONLY place this is set from wire)
                const nextId     = existingPr.Id;
                const nextNumber = existingPr?.ProductRequestNumber?.value || '';
                applyTabFields(nextId, statusValue, nextNumber, needByDateValue, needByDateValue);
                console.log('✅ Existing PR loaded:', nextId, '| Status:', statusValue);
            }
        } else {
            // No PR found for this user + shipmentType → start fresh
            applyTabFields(null, this.statusDefault, '', '', '');
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
    wiredResourceProducts(value) {
        this._rpWire = value; // store for refreshGraphQL if needed
        const { data, errors } = value || {};
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

    // Computed PRLI variables including refreshKey to force wire re-evaluation
    get computedPrliVariables() {
        const base = this.prliQueryVariables;
        if (base === undefined) return undefined;
        return { ...base, refreshKey: this.refreshKey };
    }

    @wire(graphql, { query: GET_PRLI_QUERY, variables: '$computedPrliVariables' })
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

            // Apply saved selections to UI.
            // Skip _applyQuantitiesFromPrliMap while a save is in progress —
            // the save already calls it explicitly after the wire settles.
            // Calling it here mid-save would overwrite the user's current selections.
            this._applySelectionsFromPrliMap();
            if (!this.isSaving) {
                this._applyQuantitiesFromPrliMap();
            }
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
            // Preserve the server value as-is, including 0.
            // Scheduled filter excludes defaultQuantity = 0 explicitly.
            // Unscheduled shows 0 in the input so the user can edit it.
            const defaultQuantity = (rawQty !== null && rawQty !== undefined)
                ? Number(rawQty)
                : 0;

            return {
                id:              node.Id,
                product2Id:      product2?.Id || null,
                name:            product2?.Name?.value || node?.Name?.value || '—',
                description:     product2?.Description?.value || '—',
                productCode:     product2?.ProductCode?.value || '—',
                defaultQuantity: defaultQuantity,
                isSerialized:    product2?.IsSerialized?.value === true,
                isActive:        product2?.IsActive?.value === true,
                selected:        false,
                rowClass:        'product-row'
            };
        });

        // ───────── Scheduled Logic ─────────
        // Scheduled tab: non-serialized, active products with defaultQuantity > 0 only.
        // Products with defaultQuantity = 0 are hidden — no meaningful qty for PRLI.
        // Inactive products are always excluded regardless of other criteria.
        this.allProducts = baseProducts.filter(p => p.isActive && !p.isSerialized && p.defaultQuantity > 0);

        // ───────── Unscheduled Logic ─────────
        // Initial state: qty = defaultQuantity (display value), selected = false.
        // FIX 2: Do NOT pre-select all products — defaultQuantity is for display only.
        // Selection happens ONLY when user interacts (+/-/input) or when a saved
        // PRLI is restored from the server via _applyQuantitiesFromPrliMap().
        // Unscheduled tab: serialized + non-serialized shown, but ONLY active products.
        // qty starts at defaultQuantity (or 0 if not set).
        // selected = false always — user must interact to select.
        this.unscheduledProducts = baseProducts
            .filter(p => p.isActive)
            .map(p => ({
            ...p,
            qty:            p.isSerialized ? 1 : (Number(p.defaultQuantity) || 0),
            isUserModified: false,
            selected:       false,
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
            // No PRLI → show defaultQuantity in input (display value; not a selection trigger).
            // selected is still controlled by hasPrli, so displaying defaultQuantity
            // does NOT cause the product to be included in PRLI sync.
            // hasPrli: restore saved PRLI qty (may be 0 if server stored 0).
            // No PRLI: show defaultQuantity in input (may also be 0).
            const savedQty = hasPrli ? this.prliQtyMap.get(p.product2Id) : undefined;
            const qty      = (savedQty !== null && savedQty !== undefined)
                ? savedQty
                : p.defaultQuantity;
            const nextQty  = Number(qty); // preserve 0 — do not fall back to defaultQuantity

            // FIX 3: selected = hasPrli (PRLI existence is the authoritative selection signal).
            // qty = 0 in a saved PRLI is a valid state — user may have edited it down.
            // We restore it as selected so the user can increment/edit it again without
            // having to re-tap the row to re-select it.
            // Products WITHOUT a saved PRLI remain unselected (defaultQuantity is display only).
            const nextSelected = hasPrli;

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
    // _sortProducts: selected items first, then A–Z by name within each group.
    // Uses [...arr] spread to avoid mutating the source array.
    _sortProducts(arr) {
        return [...arr].sort((a, b) => {
            // Primary: selected first (false=1 sorts after true=0)
            const selDiff = (a.selected ? 0 : 1) - (b.selected ? 0 : 1);
            if (selDiff !== 0) return selDiff;
            // Secondary: A–Z by name within the same group
            return (a.name || '').localeCompare(b.name || '');
        });
    }

    get filteredProducts() {
        const term = this.searchTerm ? this.searchTerm.toLowerCase() : null;
        const base = term
            ? this.allProducts.filter(p =>
                (p.name        && p.name.toLowerCase().includes(term)) ||
                (p.description && p.description.toLowerCase().includes(term))
              )
            : this.allProducts;
        // Selected products float to top; within each group sorted A–Z by name.
        return this._sortProducts(base);
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

    // True when at least one unscheduled product is selected with qty > 0.
    // Enables Save/Submit in the Unscheduled tab without a prior Save click.
    get hasUnscheduledSelections() {
        return this.unscheduledProducts.some(
            p => p.product2Id && p.selected && Number(p.qty || 0) > 0
        );
    }

    // Tab-aware: Unscheduled uses its own selection check so Submit is
    // available as soon as the user selects a product with qty > 0.
    // Scheduled retains the original allProducts-based check unchanged.
    get isActionsDisabled() {
        if (this.isSubmitted) return true;
        if (this.isUnscheduledTab) return !this.hasUnscheduledSelections;
        return !this.hasSelections;
    }

    // isSubmitted drives UI lock:
    //   Scheduled: locked when status = statusSubmit ONLY.
    //   Closed statuses (Closed-Rejected, Closed-Fulfilled) are terminal but NOT
    //   locked — they allow creating a new PR immediately. This handles the offline
    //   case: if the wire returns stale data with a closed status, we do NOT lock.
    //   Unscheduled: NEVER locked — submit clears activePrId so user can
    //   immediately start a new Unscheduled PR without any restriction.
    get isSubmitted() {
        if (this.isUnscheduledTab) {
            return false;
        }
        if (!this.isConfigReady || !this.activePrStatus) return false;
        // Closed statuses: treat as "no active PR" — do NOT lock the form.
        // The reset logic in _processDraftPrData and _checkAndResetIfClosed
        // will clear activePrId, but even if it hasn't fired yet (offline cache),
        // returning false here ensures the user can still interact.
        if (this.activePrStatus === this.statusClosedRejected ||
            this.activePrStatus === this.statusClosedFulfilled) {
            return false;
        }
        return this.activePrStatus === this.statusSubmit;
    }

    // ───────── Unscheduled Logic ─────────
    // Unscheduled Tab Logic (+ / - quantity handling)
    get hasUnscheduledProducts() { return this.unscheduledProducts.length > 0; }
    get filteredUnscheduledProducts() {
        const term = this.searchTerm ? this.searchTerm.toLowerCase() : null;
        const base = term
            ? this.unscheduledProducts.filter(p =>
                (p.name        && p.name.toLowerCase().includes(term)) ||
                (p.description && p.description.toLowerCase().includes(term))
              )
            : this.unscheduledProducts;
        // Same sort rule as Scheduled: selected first, then A–Z by name.
        return this._sortProducts(base);
    }
    get hasFilteredUnscheduledProducts() { return this.filteredUnscheduledProducts.length > 0; }

    handleUnscheduledToggle(event) {
        if (this.isSubmitted) return;

        const productId = event.currentTarget.dataset.productid;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;

            const nextSelected = !p.selected;

            // Toggle only flips selected — qty is NEVER changed here.
            // qty is a display/data value the user sets via +/-/input.
            // Sync works because it filters by p.selected && qty>0:
            // a deselected product is excluded from selectedIds → goes to toDelete.
            return {
                ...p,
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

        // Allow empty string while the user is mid-edit (e.g. cleared via backspace).
        // Store it as-is so the input stays stable; treat it as 0 only for numeric ops.
        const isEmpty   = rawValue === '' || rawValue === null;
        const nextValue = isEmpty ? 0 : Number(rawValue);

        if (!isEmpty && (isNaN(nextValue) || nextValue < 0)) return;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;

            // Selection is INDEPENDENT of qty.
            // - If the product was never touched, the first qty edit auto-selects it
            //   (mirrors the previous +/- behaviour: typing a value implies intent).
            // - Once already selected (or already deselected by an explicit toggle),
            //   the selected state is preserved unchanged — qty edits do NOT flip it.
            // Explicit deselection is only possible via handleUnscheduledToggle (row tap).
            const nextSelected = p.isUserModified ? p.selected : (nextValue > 0);

            return {
                ...p,
                qty:            isEmpty ? rawValue : nextValue, // preserve '' during editing
                isUserModified: true,
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
            // Increment always results in qty >= 1.
            // If already user-modified, honour the existing selected state.
            // On the very first increment of an untouched product, auto-select it
            // (positive intent is unambiguous when the user explicitly taps +).
            const nextValue    = Number(p.qty || 0) + 1;
            const nextSelected = p.isUserModified ? p.selected : true;
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
            // Clamp to 0 but do NOT auto-deselect when reaching 0.
            // Selection is controlled exclusively by handleUnscheduledToggle (row tap).
            // On the very first decrement of an untouched product: auto-select only
            // if the resulting qty is still > 0, otherwise leave unselected — the user
            // has not expressed clear intent by decrementing from default to 0.
            const next         = Math.max(0, Number(p.qty || 0) - 1);
            const nextSelected = p.isUserModified ? p.selected : (next > 0);
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
        const selectedDate = event.target.value;
        const today = this.todayDate;

        if (selectedDate && selectedDate < today) {
            event.target.setCustomValidity('Please select today or a future date');
            event.target.reportValidity();
            return;
        }
        
        if (this.originalNeedByDate && selectedDate && selectedDate < this.originalNeedByDate) {
            event.target.setCustomValidity('Cannot select a date earlier than previously saved date');
            event.target.reportValidity();
            return;
        }

        event.target.setCustomValidity('');
        this.needByDate = selectedDate || '';
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

        this.isSaving = true;
        try {
            const { delta, createErrors, updateErrors, deleteErrors } =
                await this._ensurePrAndSyncPrlis();

            const hasSaveErrors = createErrors.length > 0 || updateErrors.length > 0 || deleteErrors.length > 0;

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

    // ─────────────────────────────────────────────────────────────────────
    // _ensurePrAndSyncPrlis — shared inner logic for Save and Submit
    //
    // 1. Validates zero-qty guard (Unscheduled only) — throws on failure
    //    so the caller's catch block handles the error toast uniformly.
    // 2. Creates ProductRequest if none exists yet (Step 1).
    // 3. Syncs PRLIs (Step 2+3): create / update / delete delta.
    // 4. Refreshes wires and applies maps so UI is in sync.
    //
    // Called by handleSave (shows Save toast after) and handleSubmit
    // Unscheduled branch (shows Submit toast after). Scheduled Submit
    // still delegates to handleSave() as before — no change there.
    //
    // Assumes isSaving=true has already been set by the caller.
    // ─────────────────────────────────────────────────────────────────────
    async _ensurePrAndSyncPrlis() {
        // Clear stale prliMap entries from the now-closed PR.
        // If activePrId was reset to null (post-close), any remaining entries would
        // cause deleteRecord() calls against the closed/locked record → API errors.
        if (!this.activePrId && this.prliMap.size > 0) {
            console.log('⚠️ Clearing stale prliMap — activePrId is null (post-close reset)');
            this.prliMap = new Map();
            this.prliQtyMap = new Map();
        }

        // ── Unscheduled: zero-qty guard ──────────────────────────────────
        // Block Save / Submit if no product has qty > 0 in Unscheduled tab.
        // This check runs before any PR or PRLI creation attempt.
        if (this.isUnscheduledTab) {
            // Tier A: block if any selected product has qty = 0 or less.
            // A selected product with qty = 0 would create an invalid PRLI.
            const hasSelectedWithZeroQty = this.unscheduledProducts.some(
                p => p.product2Id && p.selected && Number(p.qty || 0) <= 0
            );
            if (hasSelectedWithZeroQty) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Invalid Selection',
                    message: 'Please select at least one product with quantity greater than zero.',
                    variant: 'warning'
                }));
                throw new Error('zero-qty');
            }

            // Tier B: block only when there is truly nothing to do.
            // hasProductsToSave: at least one selected product with qty > 0 (create/update)
            // hasPrliToDelete:   existing PRLIs whose products are now deselected (delete)
            // Preserving hasPrliToDelete allows deselect-to-remove to work correctly.
            const hasProductsToSave = this.unscheduledProducts.some(
                p => p.product2Id && p.selected && Number(p.qty || 0) > 0
            );
            const hasPrliToDelete = this.prliMap.size > 0;
            if (!hasProductsToSave && !hasPrliToDelete) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Nothing to Save',
                    message: 'Please select at least one product with quantity greater than zero.',
                    variant: 'warning'
                }));
                throw new Error('nothing-to-save');
            }
        }

        // ── STEP 1: Ensure ProductRequest exists ──────────────────────
        if (!this.activePrId && this._prLoaded) {
            const prFields = {};
            prFields[PR_STATUS.fieldApiName]          = this.statusDefault;
            prFields[PR_DESCRIPTION.fieldApiName]     = `Product Request — ${new Date().toLocaleDateString()}`;
            prFields[PR_SHIPMENT_TYPE.fieldApiName]   = this._shipmentTypeForTab(this.activeTab);
            // Associate with technician's ServiceResource — this is the key
            // that GET_DRAFT_PR_QUERY uses to find/reuse the correct PR.
            prFields[PR_SERVICE_RESOURCE.fieldApiName] = this.serviceResourceId;
            if (this.sourceLocationId) {
                prFields['SourceLocationId'] = this.sourceLocationId;
            }
            if (this.destinationLocationId) {
                prFields['DestinationLocationId'] = this.destinationLocationId;
            }
            if (this.isUnscheduledTab && this.needByDate) {
                prFields[PR_NEED_BY_DATE.fieldApiName] = new Date(this.needByDate + 'T00:00:00.000Z').toISOString();
            }

            console.log('⚡ Creating ProductRequest...');
            const prResult = await createRecord({
                apiName: PR_OBJECT.objectApiName,
                fields: prFields
            });
            this.activePrId     = prResult.id;
            this.activePrStatus = this.statusDefault;
            try { notifyRecordUpdateAvailable([{ recordId: prResult.id }]); } catch (e) {}
            console.log('✅ ProductRequest created:', this.activePrId);
            this._storeActiveTabState();
            // DO NOT call _refreshPrData() here.
            // Doing so fires wiredDraftPR → _processDraftPrData → _applyActiveTabState
            // which resets prliMap=new Map() and calls _applyQuantitiesFromPrliMap()
            // setting ALL unscheduledProducts to qty=0, selected=false — wiping the
            // user's selection BEFORE _syncUnscheduledSelections runs.
            // The PRLI wire fires reactively when activePrId changes; STEP 4 handles
            // the final refresh after sync completes.
        } else if (this.isUnscheduledTab && this.needByDate) {
            // NeedByDate is optional. Only update when a value is actually set.
            // Skipping when empty avoids a redundant null updateRecord call on every save.
            const prUpdateFields = {};
            prUpdateFields[PR_ID.fieldApiName] = this.activePrId;
            prUpdateFields[PR_NEED_BY_DATE.fieldApiName] = new Date(this.needByDate + 'T00:00:00.000Z').toISOString();
            await updateRecord({ fields: prUpdateFields });
            try { notifyRecordUpdateAvailable([{ recordId: this.activePrId }]); } catch (e) {}
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

            // Resource Product (DTVSCM_Resource_Product__c) is READ-ONLY.
            // defaultQuantity is a static display value — never written back.
        }

        const hasSaveErrors = createErrors.length > 0 || updateErrors.length > 0 || deleteErrors.length > 0;
        if (!hasSaveErrors) {
            this._saveSavedSnapshot();
        }

        // ── STEP 4: Refresh PR + PRLI wires so UI reflects saved state.
        // isSaving=true blocks wiredPrli from calling _applyQuantitiesFromPrliMap
        // mid-refresh. After the wire settles, we call it explicitly here
        // with the updated prliMap so deselected products (qty=0) are not restored.
        // Force a full refresh of GraphQL data and ensure reactive key is bumped within _refreshPrData.
        await this._refreshPrData();
        // Small delay to allow UI API cache to settle on mobile before reading wires again
        await new Promise(resolve => setTimeout(resolve, 500));

        this._applySavedSnapshotIfOffline();
        this._applySelectionsFromPrliMap();
        this._applyQuantitiesFromPrliMap();

        return { delta, createErrors, updateErrors, deleteErrors };
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
                if (this.sourceLocationId) {
                    prliFields['SourceLocationId'] = this.sourceLocationId;
                }
                if (this.destinationLocationId) {
                    prliFields['DestinationLocationId'] = this.destinationLocationId;
                }

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.defaultQuantity})`);
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);
                try { notifyRecordUpdateAvailable([{ recordId: prliResult.id }, { recordId: this.activePrId }]); } catch (e) {}

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
                    try { notifyRecordUpdateAvailable([{ recordId: recId }, { recordId: this.activePrId }]); } catch (e) {}
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
        // Snapshot maps at the start of sync — not live references.
        // This prevents wire re-fires mid-loop from changing the delta.
        const existingMap = new Map(this.prliMap);     // Product2Id → PRLI Record Id
        const existingQty = new Map(this.prliQtyMap);  // Product2Id → Quantity
        const existingIds = new Set(existingMap.keys());

        // selected=true AND qty>0: the strict filter for PRLI creation/update.
        // Deselected products (qty=0, selected=false) are excluded here and picked
        // up by toDelete below via existingIds - selectedIds.
        const selected = this.unscheduledProducts
            .filter(p => p.product2Id && p.selected && Number(p.qty || 0) > 0)
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

            // Idempotency guard: never create if PRLI already exists in local map.
            // Protects against duplicate creates if wire fires and updates prliMap
            // mid-loop, or if this method is called twice concurrently.
            if (this.prliMap.has(pid)) {
                console.warn(`⚠️ PRLI already exists for product ${p.name} — skipping create, will update instead`);
                // Treat as an update if qty differs
                const savedQty = this.prliQtyMap.get(pid);
                if (savedQty !== p.qty) {
                    try {
                        const upFields = {};
                        upFields.Id = this.prliMap.get(pid);
                        upFields[PRLI_QTY_REQUESTED.fieldApiName] = p.qty;
                        await updateRecord({ fields: upFields });
                        this.prliQtyMap.set(pid, p.qty);
                        console.log(`✅ PRLI updated (idempotency path): ${p.name} qty=${p.qty}`);
                    } catch (e) {
                        createErrors.push(`${p.name}: ${e?.body?.message || e.message}`);
                    }
                }
                continue;
            }

            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = p.qty;
                if (this.sourceLocationId) {
                    prliFields['SourceLocationId'] = this.sourceLocationId;
                }
                if (this.destinationLocationId) {
                    prliFields['DestinationLocationId'] = this.destinationLocationId;
                }

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.qty})`);
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);
                try { notifyRecordUpdateAvailable([{ recordId: prliResult.id }, { recordId: this.activePrId }]); } catch (e) {}

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
                try { notifyRecordUpdateAvailable([{ recordId: prliFields.Id }, { recordId: this.activePrId }]); } catch (e) {}
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
                    try { notifyRecordUpdateAvailable([{ recordId: recId }, { recordId: this.activePrId }]); } catch (e) {}
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
        // On some mobile clients, refreshGraphQL returns cached results even after mutations.
        // To guarantee re-evaluation, we both refresh the wires and bump a reactive key
        // that is included in the wire variables (computedDraftPrVariables/computedPrliVariables).
        const refreshes = [];
        if (this._draftPrWire) refreshes.push(refreshGraphQL(this._draftPrWire));
        if (this._prliWire)    refreshes.push(refreshGraphQL(this._prliWire));
        if (this._srWire)      refreshes.push(refreshGraphQL(this._srWire));
        if (this._rpWire)      refreshes.push(refreshGraphQL(this._rpWire));

        // Always bump the refreshKey first so that when refreshGraphQL resolves,
        // the wire variables have already changed and the adapter must re-evaluate.
        this.refreshKey = Date.now();

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
    //   - Direct Submit: _ensurePrAndSyncPrlis → status update → reset
    //   - No prior Save required. Validation (zero-qty guard) runs inside
    //     _ensurePrAndSyncPrlis, so invalid selections are blocked here too.
    //   - Form resets after submit so user can immediately create a new PR.
    //   - isSubmitted getter always returns false for Unscheduled tab.
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

        // ── UNSCHEDULED: direct submit path ──────────────────────────────
        // Bypasses handleSave() to avoid the "✅ Saved" toast and double-refresh.
        // _ensurePrAndSyncPrlis handles: zero-qty guard → PR create → PRLI sync → refresh.
        if (this.isUnscheduledTab) {
            if (!this.isPrReady) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Please wait',
                    message: 'Loading existing Product Request...',
                    variant: 'info'
                }));
                return;
            }

            this.isSaving = true;
            try {
                // Step 1+2+3: create PR if needed, sync PRLIs
                await this._ensurePrAndSyncPrlis();

                if (!this.activePrId) {
                    this.dispatchEvent(new ShowToastEvent({
                        title: 'Submit Blocked',
                        message: 'Could not create Product Request.',
                        variant: 'error'
                    }));
                    return;
                }

                // Step 4: update PR status to Submitted
                const fields = {};
                fields[PR_ID.fieldApiName]     = this.activePrId;
                fields[PR_STATUS.fieldApiName] = this.statusSubmit;

                console.log('⚡ Submitting Unscheduled PR:', this.activePrId);
                await updateRecord({ fields });
                console.log('✅ Unscheduled PR submitted');
                try { notifyRecordUpdateAvailable([{ recordId: this.activePrId }]); } catch (e) {}

                this._resetIfClosedStatus(fields[PR_STATUS.fieldApiName]);

                // Reset state so user can create a new Unscheduled PR immediately.
                // Do NOT lock the form — isSubmitted always returns false here.
                const submittedId = this.activePrId;
                this.activePrId              = null;
                this.activePrStatus          = null;
                this.activePrNumber          = '';
                this.activeUnscheduledPrId     = null;
                this.activeUnscheduledPrStatus = null;
                this.activeUnscheduledPrNumber = '';
                this.unscheduledNeedByDate     = '';
                this.unscheduledOriginalNeedByDate = '';
                this.needByDate               = '';
                this.originalNeedByDate        = '';
                this.prliMap                  = new Map();
                this.prliQtyMap               = new Map();
                this._pendingQtyChanges       = new Map();

                // Reset to clean slate — matches initial build state exactly.
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

            } catch (e) {
                // Validation errors ('zero-qty', 'nothing-to-save') already toasted
                // inside _ensurePrAndSyncPrlis — only surface unexpected errors here.
                if (e?.message !== 'zero-qty' && e?.message !== 'nothing-to-save') {
                    console.error('❌ Unscheduled Submit failed:', e);
                    this.dispatchEvent(new ShowToastEvent({
                        title: 'Submit Failed',
                        message: e?.body?.message || e.message,
                        variant: 'error', mode: 'sticky'
                    }));
                }
            } finally {
                this.isSaving = false;
            }
            return;
        }

        // ── SCHEDULED: existing flow — Save first, then status update ────
        // Save first to sync PRLIs
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
            try { notifyRecordUpdateAvailable([{ recordId: this.activePrId }]); } catch (e) {}
            // _refreshPrData will bump refreshKey and refresh GraphQL wires
            await this._refreshPrData();

            this._resetIfClosedStatus(fields[PR_STATUS.fieldApiName]);

            // ── SCHEDULED: lock UI as before ──────────────────────────────
            this.activePrStatus = this.statusSubmit;

            // OFFLINE-SAFE: write the new status into the tab-slot backing store
            // immediately so that if wiredDraftPR re-fires with stale cached data
            // (common on mobile), _applyActiveTabState restores the correct
            // submitted status instead of overwriting it with the old draft value.
            // Without this, mobile GraphQL cache can reset the lock after submit.
            this._storeActiveTabState();
            console.log('STATUS AFTER SUBMIT:', this.activePrStatus);

            this.allProducts = this.allProducts.map(p => ({
                ...p,
                rowClass: p.selected ? 'product-row selected' : 'product-row'
            }));

            this.dispatchEvent(new ShowToastEvent({
                title: '✅ Submitted',
                message: 'Product Request submitted successfully.',
                variant: 'success'
            }));

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
    // @wire — PR Config from Custom Metadata (Apex — offline-safe)
    //
    // Moved from GraphQL/UI API to Apex: UI API does NOT support Custom Metadata
    // offline priming/caching. Apex @AuraEnabled(cacheable=true) is supported.
    //
    // Apex returns DtvscmProductRequestController.PrConfigResult with fields:
    //   defaultStatus, submitStatus, closedRejectedStatus, closedFulfilledStatus
    // These map 1-to-1 to this.config — no downstream logic changed.
    // ─────────────────────────────────────────────────────────────────────
    @wire(getPrConfig)
    wiredPrConfig({ data, error }) {
        if (data === undefined && error === undefined) return;

        if (error) {
            console.warn('⚠️ PR Config Apex error:', JSON.stringify(error));
            this._configLoaded = true;
            // If PR wire already instantiated, refresh to allow it to run with defaults
            if (this._draftPrWire) {
                try { refreshGraphQL(this._draftPrWire); } catch (e) {}
            }
            return;
        }
        try {
            // Apex returns a named-field wrapper — map directly to this.config.
            // Field names match existing this.config keys; no downstream changes needed.
            const map = {
                defaultStatus:         data?.defaultStatus,
                submitStatus:          data?.submitStatus,
                closedRejectedStatus:  data?.closedRejectedStatus,
                closedFulfilledStatus: data?.closedFulfilledStatus
            };

            if (!map.defaultStatus || !map.submitStatus || !map.closedRejectedStatus || !map.closedFulfilledStatus) {
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
