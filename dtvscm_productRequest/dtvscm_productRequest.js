import { LightningElement, wire, track, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import FORM_FACTOR from '@salesforce/client/formFactor';

import { gql, graphql, refreshGraphQL } from 'lightning/uiGraphQLApi';
import { createRecord, updateRecord, deleteRecord } from 'lightning/uiRecordApi';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';
import USER_ID from '@salesforce/user/Id';

// ProductRequest schema tokens
import PR_OBJECT      from '@salesforce/schema/ProductRequest';
import PR_STATUS      from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION from '@salesforce/schema/ProductRequest.Description';
import PR_NEED_BY_DATE from '@salesforce/schema/ProductRequest.NeedByDate';
import PR_ID          from '@salesforce/schema/ProductRequest.Id';
import PR_SHIPMENT_TYPE    from '@salesforce/schema/ProductRequest.ShipmentType';
import PR_SERVICE_RESOURCE from '@salesforce/schema/ProductRequest.DTVSCM_Service_Resource__c';
import PR_RECORD_TYPE_ID   from '@salesforce/schema/ProductRequest.RecordTypeId';
import PR_SUBMIT_DATE from '@salesforce/schema/ProductRequest.DTVSCM_Submit_Date__c';

// ProductRequestLineItem schema tokens
import PRLI_OBJECT        from '@salesforce/schema/ProductRequestLineItem';
import PRLI_PR_ID         from '@salesforce/schema/ProductRequestLineItem.ParentId';
import PRLI_PRODUCT2_ID   from '@salesforce/schema/ProductRequestLineItem.Product2Id';
import PRLI_QTY_REQUESTED from '@salesforce/schema/ProductRequestLineItem.QuantityRequested';
import PRLI_STATUS        from '@salesforce/schema/ProductRequestLineItem.Status';
import PRLI_RECORD_TYPE_ID from '@salesforce/schema/ProductRequestLineItem.RecordTypeId';

// Resource Product schema tokens — used to update Default Quantity on Save
// DTVSCM_Default_Quantity__c is updated ONLY after user clicks Save
import RP_OBJECT     from '@salesforce/schema/DTVSCM_Resource_Product__c';
import RP_ID         from '@salesforce/schema/DTVSCM_Resource_Product__c.Id';
import RP_DEFAULT_QTY from '@salesforce/schema/DTVSCM_Resource_Product__c.DTVSCM_Default_Quantity__c';


const FORM_FACTOR_SMALL = 'Small';      
const FORM_FACTOR_LARGE = 'Large';

const TAB_SCHEDULED = 'scheduled';
const TAB_UNSCHEDULED = 'unscheduled';

const SHIPMENT_TYPE_SCHEDULED = 'Scheduled';
const SHIPMENT_TYPE_UNSCHEDULED = 'Unscheduled';

// Temporary hardcoded Product Request status values (offline compatible)
const STATUS_DEFAULT = 'Draft';
const STATUS_SUBMIT = 'Submitted';
const STATUS_ERROR_IN_SUBMISSION = 'Error In Submission';
const STATUS_CLOSED_REJECTED = 'Closed - Rejected';
const STATUS_CLOSED_FULFILLED = 'Closed - Fulfilled';
const RECORD_TYPE_FIELD_SERVICE = 'Field_Service';
const SAVE_MESSAGE = 'Saved successfully';
const SUBMIT_MESSAGE = 'Submitted successfully';
const NO_CHANGES_MESSAGE = 'No changes to save';
const ACTIVE_PR_REFRESH_MIN_AGE_MS = 1000;
const PRLI_REFRESH_MIN_AGE_MS = 1000;
const PENDING_PRLI_SYNC_TIMEOUT_MS = 8000;
const POST_SAVE_PRLI_REFRESH_DELAYS_MS = [750, 2000, 5000];
const PRLI_DML_BATCH_SIZE = 8;

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 1 — ServiceResource for running user
// ─────────────────────────────────────────────────────────────────────────────
const GET_SERVICE_RESOURCE_QUERY = gql`
    query GetServiceResource($userId: ID) {
        uiapi {
            query {
                ServiceResource(
                    where: {
                        and: [
                            { RelatedRecordId: { eq: $userId } }
                            { IsActive: { eq: true } }
                        ]
                    }
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

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 1b — ServiceResource by Id (external technician selection)
// ─────────────────────────────────────────────────────────────────────────────
const GET_SERVICE_RESOURCE_BY_ID_QUERY = gql`
    query GetServiceResourceById($serviceResourceId: ID) {
        uiapi {
            query {
                ServiceResource(
                    where: {
                        and: [
                            { Id: { eq: $serviceResourceId } }
                            { IsActive: { eq: true } }
                        ]
                    }
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
 * GraphQL QUERY 2 — Priority ProductRequest for running user
 * 1) Error In Submission (oldest)
 * 2) Draft (oldest)
 * 3) Submitted (latest) — fallback to preserve scheduled lock behavior
 */
const GET_DRAFT_PR_QUERY = gql`
    query GetDraftPR(
        $serviceResourceId: ID,
        $shipmentType: Picklist,
        $errorStatus: Picklist,
        $draftStatus: Picklist,
        $submitStatus: Picklist
    ) {
        uiapi {
            query {
                ErrorPr: ProductRequest(
                    where: {
                        DTVSCM_Service_Resource__c: { eq: $serviceResourceId }
                        ShipmentType: { eq: $shipmentType }
                        Status: { eq: $errorStatus }
                    }
                    orderBy: { CreatedDate: { order: ASC } }
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
                DraftPr: ProductRequest(
                    where: {
                        DTVSCM_Service_Resource__c: { eq: $serviceResourceId }
                        ShipmentType: { eq: $shipmentType }
                        Status: { eq: $draftStatus }
                    }
                    orderBy: { CreatedDate: { order: ASC } }
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
                SubmittedPr: ProductRequest(
                    where: {
                        DTVSCM_Service_Resource__c: { eq: $serviceResourceId }
                        ShipmentType: { eq: $shipmentType }
                        Status: { eq: $submitStatus }
                    }
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
// GraphQL QUERY 3 — Resource Products filtered by SR and active Product2
// ─────────────────────────────────────────────────────────────────────────────
const GET_RESOURCE_PRODUCTS_QUERY = gql`
    query GetResourceProducts($serviceResourceId: ID) {
        uiapi {
            query {
                DTVSCM_Resource_Product__c(
                    where: {
                        DTVSCM_ServiceResource__c: { eq: $serviceResourceId }
                        DTVSCM_IsActive__c: { eq: true }
                        DTVSCM_Product__r: { IsActive: { eq: true } }
                    }
                    orderBy: { Name: { order: ASC } }
                    first: 1500
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
                                QuantityUnitOfMeasure { value }
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

export default class Dtvscm_productRequest extends LightningElement {

    // ── External API — set by parent (warehouse manager) ──────────────────
    @api externalServiceResourceId;

    // ── formFactor ────────────────────────────────────────────────────────
    get isMobile()  { return FORM_FACTOR === FORM_FACTOR_SMALL; }
    get isDesktop() { return FORM_FACTOR === FORM_FACTOR_LARGE; }

    get todayDate() {
        return new Date().toISOString().split('T')[0];
    }

    get formattedNeedByDate() {
        if (!this.needByDate) return '';
        const date = new Date(`${this.needByDate}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-US');
    }

    get needByDateInputValue() {
        return this.needByDate || '';
    }

    _normalizeNeedByDateToUtc(value) {
    if (!value) return null;
    const datePart = String(value).split('T')[0];
    return `${datePart}T12:00:00.000Z`;
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
        if (this.isScheduledTab && nextTab === TAB_UNSCHEDULED && !this._unscheduledRefreshDone) {
            this._unscheduledRefreshPending = true;
        }
        this.activeTab = nextTab;
        // Reset _prLoaded so the wire result for the new tab
        // is processed fresh, not skipped as already-loaded.
        this._prLoaded = false;
        this._applyActiveTabState();
        this._refreshForLifecycleEvent(true);
    }

    _shipmentTypeForTab(tab) {
        return tab === TAB_SCHEDULED ? SHIPMENT_TYPE_SCHEDULED : SHIPMENT_TYPE_UNSCHEDULED;
    }

    _storeActiveTabState() {
        if (this.isScheduledTab) {
            this.activeScheduledPrId = this.activePrId;
            this.activeScheduledPrStatus = this.activePrStatus;
            this.activeScheduledPrNumber = this.activePrNumber;
            //this.scheduledNeedByDate = this.needByDate;
        } else {
            this.activeUnscheduledPrId = this.activePrId;
            this.activeUnscheduledPrStatus = this.activePrStatus;
            this.activeUnscheduledPrNumber = this.activePrNumber;
            this.unscheduledNeedByDate = this.needByDate;
            this.unscheduledOriginalNeedByDate = this.originalNeedByDate;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // _checkAndResetIfClosed — proactive offline-safe closed-status check
    //
    // Called from _applyActiveTabState on every state restore so it runs in
    // ALL code paths: tab switch, initial load, post-save, post-submit.
    //
    // On mobile, refreshGraphQL may return stale cached data after a PR's
    // status changes externally to Closed-Rejected or Closed-Fulfilled.
    // wiredDraftPR may never re-fire with the new status, leaving activePrStatus
    // stuck at 'Submitted' and the form permanently locked.
    //
    // By checking activePrStatus eagerly here, we break that wire dependency:
    // as soon as any code path calls _applyActiveTabState with a closed status,
    // the state is cleared immediately — no wire re-fire required.
    // ─────────────────────────────────────────────────────────────────────
    _checkAndResetIfClosed() {
        if (!this.isConfigReady) return;
        // Guard against re-entrant calls:
        // _resetActivePrStateForOfflineClose → _applyActiveTabState → here
        if (this._isResettingClosed) return;
        if (this.isScheduledTab &&
            this.activePrStatus !== null &&
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

    // Clears the tab-slot backing store fields so the next _applyActiveTabState
    // restores a clean "no active PR" state. Does NOT call _applyActiveTabState
    // directly — that is left to _checkAndResetIfClosed so the guard works correctly.
    _resetActivePrStateForOfflineClose() {
        if (this.isScheduledTab) {
            this.activeScheduledPrId     = null;
            this.activeScheduledPrStatus = this.statusDefault;
            this.activeScheduledPrNumber = '';
            this.scheduledNeedByDate     = '';
            this._scheduledSelectionDirty = false;
        } else {
            this.activeUnscheduledPrId             = null;
            this.activeUnscheduledPrStatus         = this.statusDefault;
            this.activeUnscheduledPrNumber         = '';
            this.unscheduledNeedByDate             = '';
            this.unscheduledOriginalNeedByDate     = '';
        }
        // Re-apply so activePrId / activePrStatus reflect the cleared backing store.
        this._applyActiveTabState();
    }

    _applyActiveTabState() {
        const prevActivePrId = this.activePrId;
        let nextActivePrId = null;
        if (this.isScheduledTab) {
            nextActivePrId = this.activeScheduledPrId || null;
            this.activePrId = nextActivePrId;
            this.activePrStatus = this.activeScheduledPrStatus || null;
            this.activePrNumber = this.activeScheduledPrNumber || '';
            this.needByDate = this.scheduledNeedByDate || '';
            this.originalNeedByDate = '';
        } else {
            nextActivePrId = this.activeUnscheduledPrId || null;
            this.activePrId = nextActivePrId;
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
        const shouldResetPrli = !this.isSaving &&
            (!nextActivePrId || nextActivePrId !== prevActivePrId);
        if (shouldResetPrli) {
            this.prliMap = new Map();
            this.prliQtyMap = new Map();
            this.prliLoaded = false;
        }

        // Proactive closed-status check — runs on every state restore.
        // If activePrStatus is already a closed status (from stale GraphQL cache
        // or an external status change), resets immediately without waiting for
        // wiredDraftPR to re-fire. This is the core fix for mobile offline lock.
        this._checkAndResetIfClosed();

        const hasPrliData = !this.activePrId || this.prliLoaded;
        const scheduledDirty = this._scheduledSelectionDirty && !this._allowSelectionApplyDuringSave;
        const shouldApplySelections = !this.isScheduledTab || (hasPrliData && !scheduledDirty);
        if (shouldApplySelections) {
            this._applySelectionsFromPrliMap();
        }
        if (!this.isSaving) {
            this._applyQuantitiesFromPrliMap();
        }
    }

    // ── Back ──────────────────────────────────────────────────────────────
   handleBack() {
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
        this._focusHandler = this.handleAppFocus.bind(this);
        this._pageShowHandler = this.handleAppFocus.bind(this);
        this._visibilityHandler = this.handleVisibilityChange.bind(this);
        window.addEventListener('online',  this._onlineHandler);
        window.addEventListener('offline', this._offlineHandler);
        window.addEventListener('focus', this._focusHandler);
        window.addEventListener('pageshow', this._pageShowHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);
        this.isOnline = navigator.onLine;
        this._refreshForLifecycleEvent(true);
    }

    disconnectedCallback() {
        window.removeEventListener('online',  this._onlineHandler);
        window.removeEventListener('offline', this._offlineHandler);
        window.removeEventListener('focus', this._focusHandler);
        window.removeEventListener('pageshow', this._pageShowHandler);
        document.removeEventListener('visibilitychange', this._visibilityHandler);
        this._clearPostSavePrliRefreshes();
    }

    handleOnline() {
        this.isOnline = true;
        this._refreshForLifecycleEvent(true);
        if (this.offlineQueue.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Back Online!',
                message: `${this.offlineQueue.length} request(s) ready to sync.`,
                variant: 'info'
            }));
        }
    }

    handleAppFocus() {
        this._refreshForLifecycleEvent(true);
    }

    handleVisibilityChange() {
        if (document.hidden) return;
        this._refreshForLifecycleEvent(true);
    }

    handleOffline() {
        this.isOnline = false;
        if (this.showOfflineMessage) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'You are Offline',
                message: 'Submissions will be queued and synced when online.',
                variant: 'warning', mode: 'sticky'
            }));
        }
    }

    get showOfflineMessage() { return this.isMobile && !this.isOnline; }
    get networkBannerClass() { return this.isOnline ? 'net-banner online' : 'net-banner offline'; }
    get networkLabel() {
        if (this.isOnline) return '🟢 Online';
        return '🔴 Offline — submissions will be queued';
    }
    get networkInlineLabel() {
        return this.isOnline ? '🟢 Online' : '🔴 Offline — submissions will be queued';
    }
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

    // Internal flags to track which wires have resolved
    _srLoaded  = false;
    _prLoaded  = false;
    _rpLoaded  = false;

    // FIX 2: Cache PR wire result when it fires before config is ready.
    // Processed in wiredPrConfig once config is available.
    _pendingPrWireData = null;

    // Status config (hardcoded for offline compatibility)
    @track _configLoaded = true;

    get statusDefault() { return STATUS_DEFAULT; }
    get statusSubmit() { return STATUS_SUBMIT; }
    get statusErrorInSubmission() { return STATUS_ERROR_IN_SUBMISSION; }
    get statusClosedRejected() { return STATUS_CLOSED_REJECTED; }
    get statusClosedFulfilled() { return STATUS_CLOSED_FULFILLED; }

    @wire(getObjectInfo, { objectApiName: PR_OBJECT })
    prObjectInfo;

    @wire(getObjectInfo, { objectApiName: PRLI_OBJECT })
    prliObjectInfo;

    get prRecordTypeId() {
        return this._getRecordTypeId(this.prObjectInfo);
    }

    get prliRecordTypeId() {
        return this._getRecordTypeId(this.prliObjectInfo);
    }

    get isConfigReady() { return true; }

    get isPrReady() {
        return this._prLoaded && this._configLoaded;
    }

    _getRecordTypeId(objectInfo) {
        const recordTypeInfos = objectInfo?.data?.recordTypeInfos;
        if (!recordTypeInfos) return null;
        const match = Object.values(recordTypeInfos)
            .find((info) => info?.developerName === RECORD_TYPE_FIELD_SERVICE);
        return match ? match.recordTypeId : null;
    }

    _applyRecordTypeId(fields, recordTypeId, fieldToken) {
        if (!recordTypeId || !fieldToken) return;
        fields[fieldToken.fieldApiName] = recordTypeId;
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
    _scheduledSelectionDirty = false; // Scheduled tab has unsaved selection changes
    _unscheduledSelectionDirty = false; // Preserve unsaved Unscheduled edits during refresh
    // ─────────────────────────────────────────────────────────────────────

    // Cached wire results for refreshGraphQL
    _draftPrWire = null;
    _rpWire = null;
    _prliWire = null;

    // Guard flag for _checkAndResetIfClosed to prevent re-entrant calls.
    // _resetActivePrStateForOfflineClose calls _applyActiveTabState which
    // calls _checkAndResetIfClosed again — this flag breaks that cycle.
    _isResettingClosed = false;
    _isRefreshingActivePr = false;
    _lastActivePrRefreshAt = 0;
    _isRefreshingResourceProducts = false;
    _allowSelectionApplyDuringSave = false;
    _pendingPrliSync = false;
    _expectedPrliProductIds = null;
    _pendingPrliSyncStartedAt = null;
    _isRefreshingPrli = false;
    _lastPrliRefreshAt = 0;
    _postSavePrliRefreshTimerIds = [];
    _unscheduledRefreshPending = false;
    _unscheduledRefreshDone = false;

    _refreshForLifecycleEvent(force = true) {
        Promise.resolve().then(() => {
            if (!this.isOnline) return;
            if (this.isSaving) return;
            this._refreshResourceProducts();
            this._refreshActivePrIfNeeded(force);
            this._refreshPrliIfNeeded(force);
        });
    }

    _refreshActivePrIfNeeded(force = false) {
        if (!this.isOnline) return;
        if (this.isSaving) return;
        if (!this.serviceResourceId) return;
        if (!this._draftPrWire) return;
        if (this._isRefreshingActivePr) return;
        if (this.isScheduledTab && this._scheduledSelectionDirty) return;
        if (this.isUnscheduledTab && this._unscheduledSelectionDirty) return;

        const now = Date.now();
        if (!force && now - this._lastActivePrRefreshAt < ACTIVE_PR_REFRESH_MIN_AGE_MS) return;

        this._isRefreshingActivePr = true;
        this._lastActivePrRefreshAt = now;
        refreshGraphQL(this._draftPrWire)
            .catch((e) => {
                console.warn('⚠️ Active PR refresh failed:', e);
            })
            .finally(() => {
                this._isRefreshingActivePr = false;
            });
    }

    _maybeRefreshUnscheduledAfterSwitch() {
        if (!this._unscheduledRefreshPending) return;
        if (this.isScheduledTab) return;
        if (!this.isOnline) return;
        if (!this._draftPrWire) return;

        this._unscheduledRefreshPending = false;
        this._unscheduledRefreshDone = true;
        refreshGraphQL(this._draftPrWire)
            .catch((e) => {
                console.warn('⚠️ Unscheduled PR refresh failed:', e);
            });
    }

    _refreshResourceProducts() {
        if (!this.isOnline) return;
        if (!this._rpWire) return;
        if (this._isRefreshingResourceProducts) return;
        this._isRefreshingResourceProducts = true;
        refreshGraphQL(this._rpWire)
            .catch((e) => {
                console.warn('⚠️ Resource Products refresh failed:', e);
            })
            .finally(() => {
                this._isRefreshingResourceProducts = false;
            });
    }

    _refreshPrliIfNeeded(force = false) {
        if (!this.isOnline) return;
        if (this.isSaving) return;
        if (!this.activePrId) return;
        if (!this._prliWire) return;
        if (this._isRefreshingPrli) return;
        if (this._pendingPrliSync) return;
        if (this.isScheduledTab && this._scheduledSelectionDirty) return;
        if (this.isUnscheduledTab && this._unscheduledSelectionDirty) return;

        const now = Date.now();
        if (!force && now - this._lastPrliRefreshAt < PRLI_REFRESH_MIN_AGE_MS) return;

        this._isRefreshingPrli = true;
        this._lastPrliRefreshAt = now;
        refreshGraphQL(this._prliWire)
            .catch((e) => {
                console.warn('⚠️ PRLI refresh failed:', e);
            })
            .finally(() => {
                this._isRefreshingPrli = false;
            });
    }

    _clearPostSavePrliRefreshes() {
        for (const timerId of this._postSavePrliRefreshTimerIds) {
            clearTimeout(timerId);
        }
        this._postSavePrliRefreshTimerIds = [];
    }

    _schedulePostSavePrliRefreshes() {
        this._clearPostSavePrliRefreshes();
        if (!this.isOnline || !this.activePrId) return;

        this._postSavePrliRefreshTimerIds = POST_SAVE_PRLI_REFRESH_DELAYS_MS.map((delayMs) =>
            setTimeout(() => {
                this._refreshPrliAfterSave().catch(() => {});
            }, delayMs)
        );
    }

    async _refreshPrliAfterSave() {
        if (!this.isOnline) return;
        if (!this.activePrId) return;
        if (!this._prliWire) return;

        try {
            await refreshGraphQL(this._prliWire);
        } catch (e) {
            console.warn('⚠️ Delayed PRLI refresh failed:', e);
        }

        this._releasePendingPrliSyncIfStale();
    }

    _releasePendingPrliSyncIfStale() {
        if (!this._pendingPrliSync || !this._pendingPrliSyncStartedAt) return;
        if (Date.now() - this._pendingPrliSyncStartedAt < PENDING_PRLI_SYNC_TIMEOUT_MS) return;

        console.warn('⚠️ PRLI sync confirmation timed out — preserving local DML state');
        this._pendingPrliSync = false;
        this._expectedPrliProductIds = null;
        this._pendingPrliSyncStartedAt = null;
        this._applyPrliStateFromCurrentMaps();
    }

    _applyPrliStateFromCurrentMaps() {
        const wasPendingPrliSync = this._pendingPrliSync;
        this._pendingPrliSync = false;
        this._allowSelectionApplyDuringSave = true;
        try {
            this._applySelectionsFromPrliMap();
            this._applyQuantitiesFromPrliMap();
        } finally {
            this._allowSelectionApplyDuringSave = false;
            this._pendingPrliSync = wasPendingPrliSync &&
                this._expectedPrliProductIds !== null &&
                this._expectedPrliProductIds !== undefined;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 1 — ServiceResource for running user
    //
    // Reactive variable: passes USER_ID at runtime (NOT string interpolation)
    // ────────────────────────   ────────────────────────────────────────────
    get srVariables() {
        if (this.externalServiceResourceId) return undefined;
        return { userId: USER_ID };
    }

    @wire(graphql, { query: GET_SERVICE_RESOURCE_QUERY, variables: '$srVariables' })
    wiredServiceResource(value) {
        this._handleServiceResourceWire(value);
    }

    // @wire 1b — ServiceResource by Id (external technician from parent)
    get srByIdVariables() {
        if (!this.externalServiceResourceId) return undefined;
        return { serviceResourceId: this.externalServiceResourceId };
    }

    @wire(graphql, { query: GET_SERVICE_RESOURCE_BY_ID_QUERY, variables: '$srByIdVariables' })
    wiredServiceResourceById(value) {
        this._handleServiceResourceWire(value);
    }

    _handleServiceResourceWire({ data, errors } = {}) {
        if (data === undefined && errors === undefined) return;

        this._srLoaded = true;

        if (errors) {
            console.error('❌ ServiceResource wire error:', JSON.stringify(errors));
            this.serviceResourceId = null;
            this._prLoaded = true;
            this._rpLoaded = true;
            this._rpEdgesAll = [];
            this._tryBuildProducts();
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
            if (!this.serviceResourceId) {
                this._prLoaded = true;
                this._rpLoaded = true;
                this._rpEdgesAll = [];
            }
            this._tryBuildProducts();
            this._tryFinishLoading();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 2 — Draft ProductRequest for running user
    // ───────────────────────────────────────────────────────────────   ─────
    get draftPrVariables() {
        // Do NOT gate on isConfigReady here (see original comment).
        // Gate on serviceResourceId: if the SR wire hasn't resolved yet,
        // returning undefined suppresses this wire so it doesn't fire with
        // a null ID. It will re-fire automatically once serviceResourceId is set.
        if (!this.serviceResourceId) return undefined;
        return {
            serviceResourceId: this.serviceResourceId,
            shipmentType:      this._shipmentTypeForTab(this.activeTab),
            errorStatus:       this.statusErrorInSubmission,
            draftStatus:       this.statusDefault,
            submitStatus:      this.statusSubmit
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

        const errorEdges = data?.uiapi?.query?.ErrorPr?.edges || [];
        const draftEdges = data?.uiapi?.query?.DraftPr?.edges || [];
        const submittedEdges = data?.uiapi?.query?.SubmittedPr?.edges || [];
        console.log(
            '🔍 PR QUERY RESULT — error:', errorEdges.length,
            '| draft:', draftEdges.length,
            '| submitted:', submittedEdges.length
        );
        const existingPr = errorEdges[0]?.node || draftEdges[0]?.node || submittedEdges[0]?.node || null;

        const isScheduled = this.isScheduledTab;
        const statusValue = existingPr?.Status?.value || this.statusDefault;
        const closedRejectedStatus  = this.statusClosedRejected;
        const closedFulfilledStatus = this.statusClosedFulfilled;
        const submitStatus          = this.statusSubmit;
        const defaultStatus         = this.statusDefault;

        if (
            this.isScheduledTab &&
            this.activePrId &&
            this.activePrStatus === submitStatus &&
            existingPr &&
            existingPr.Id !== this.activePrId
        ) {
            console.log('⏭️ Skip PR switch — current submitted PR is locked');
            this._tryFinishLoading();
            return;
        }

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
            const rawNeedByDate         = existingPr?.NeedByDate?.value || '';
            const needByDateValue       = rawNeedByDate ? String(rawNeedByDate).split('T')[0] : '';

            console.log('PR FOUND:', existingPr?.Id, '|', statusValue, '| tab:', isScheduled ? 'Scheduled' : 'Unscheduled');

            // Scheduled tab lifecycle:
            // - Submitted: keep active PR and lock UI (no reset here)
            // - Closed - Fulfilled / Closed - Rejected: terminal → allow a new PR
            // Unscheduled tab is NOT affected by this block (handled separately below).
            if (
                isScheduled &&
                (
                    statusValue === closedRejectedStatus ||
                    statusValue === closedFulfilledStatus
                )
            ) {
                applyTabFields(null, defaultStatus, '', '', '');
                console.log('⚠️ Scheduled PR is closed (' + statusValue + ') — resetting so new PR can be created');

            } else if (
                !isScheduled &&
                (
                    statusValue === submitStatus ||
                    statusValue === closedRejectedStatus ||
                    statusValue === closedFulfilledStatus
                )
            ) {
                // Unscheduled + Submitted → treat as no active PR.
                // After submit, keep the UI in a fresh state for a new PR.
                applyTabFields(null, defaultStatus, '', '', '');
                console.log('⚠️ Unscheduled PR is Submitted/Closed — resetting so new PR can be created immediately');

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
        this._maybeRefreshUnscheduledAfterSwitch();
        this._tryFinishLoading();
    }

    get hasActivePrInfo() {
        return this.isPrReady;
    }

    get showNoServiceResource() {
        return this._srLoaded && !this.serviceResourceId;
    }

    get showNoProducts() {
        return this._srLoaded && this._rpLoaded && this.serviceResourceId && this._rpEdgesAll.length === 0;
    }

    get displayPrNumber() {
        return this.activePrId ? (this.activePrNumber || '—') : '—';
    }

    get displayPrStatus() {
        return this.activePrId ? (this.activePrStatus || '—') : '—';
    }

    get activePrInfoLabel() {
        return `Product Request: ${this.displayPrNumber} | Status: ${this.displayPrStatus}`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // @wire 3 — Resource Products filtered by serviceResourceId and active Product2
    // ──────────────────────────   ──────────────────────────────────────────
    get resourceProductsVariables() {
        if (!this.serviceResourceId) return undefined;
        return { serviceResourceId: this.serviceResourceId };
    }

    @wire(graphql, { query: GET_RESOURCE_PRODUCTS_QUERY, variables: '$resourceProductsVariables' })
    wiredResourceProducts(value) {
        this._rpWire = value;
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
            console.log('✅ Resource Products fetched (filtered):', this._rpEdgesAll.length);
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

            let resolvedPendingSync = false;
            if (this._pendingPrliSync) {
                const expected = this._expectedPrliProductIds || new Set();
                const wireIds = new Set(map.keys());
                const matches = wireIds.size === expected.size &&
                    [...wireIds].every(id => expected.has(id));
                if (!matches) {
                    this._releasePendingPrliSyncIfStale();
                    console.log('⏳ PRLI wire skipped — waiting for stable sync');
                    return;
                }
                this._pendingPrliSync = false;
                this._expectedPrliProductIds = null;
                this._pendingPrliSyncStartedAt = null;
                resolvedPendingSync = true;
            }

            this.prliMap    = map;
            this.prliQtyMap = qtyMap;
            this.prliLoaded = true;
            console.log('✅ PRLI map loaded:', map.size, 'entries');

            this._applySavedSnapshotIfOffline();

            if (this.isSaving) {
                if (resolvedPendingSync) {
                    this._allowSelectionApplyDuringSave = true;
                    try {
                        this._applySelectionsFromPrliMap();
                        this._applyQuantitiesFromPrliMap();
                    } finally {
                        this._allowSelectionApplyDuringSave = false;
                    }
                }
                return;
            }

            // Apply saved selections to UI.
            this._applySelectionsFromPrliMap();
            if (!this.isSaving) {
                this._applyQuantitiesFromPrliMap();
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Build product list once BOTH SR + RP wires have resolved
    // Resource Products are filtered by ServiceResource in GraphQL.
    // ──────────────────────────────────────────────────────   ──────────────
    _tryBuildProducts() {
        if (this.isUnscheduledTab && this.isSaving) {
            console.log('⏭️ Skip product rebuild — unscheduled save in progress');
            return;
        }
        if (this.isScheduledTab && this.isSaving) {
            console.log('⏭️ Skip product rebuild — save in progress');
            return;
        }
        // Need both SR resolved and RP edges loaded
        if (!this._srLoaded || !this._rpLoaded) return;
        if (!this.serviceResourceId) {
            console.warn('⚠️ No ServiceResource — cannot filter Resource Products');
            this.allProducts = [];
            this.unscheduledProducts = [];
            return;
        }

        const rpEdges = this._rpEdgesAll;

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
                quantityUOM:     product2?.QuantityUnitOfMeasure?.value || null,
                defaultQuantity: defaultQuantity,
                isSerialized:    product2?.IsSerialized?.value === true,
                isActive:        product2?.IsActive?.value === true,
                selected:        false,
                rowClass:        'product-row'
            };
        });



        console.log('📦 ALL BASE PRODUCTS:', JSON.parse(JSON.stringify(baseProducts)));

        baseProducts.forEach((p) => {
            console.log(
                `🔍 Product: ${p.name} | ` +
                `Code=${p.productCode} | ` +
                `isActive=${p.isActive} | ` +
                `isSerialized=${p.isSerialized} | ` +
                `defaultQuantity=${p.defaultQuantity}`
            );
        });

        const scheduledProducts = baseProducts.filter(
            p => p.isActive && !p.isSerialized && p.defaultQuantity > 0
        );

        console.log(
            '📅 SCHEDULED PRODUCTS:',
            JSON.parse(JSON.stringify(scheduledProducts))
        );

        const unscheduledProducts = baseProducts.filter(
            p => p.isActive
        );

        console.log(
            '🕒 UNSCHEDULED PRODUCTS:',
            JSON.parse(JSON.stringify(unscheduledProducts))
        );

        baseProducts.forEach((p) => {
            if (!(p.isActive && !p.isSerialized && p.defaultQuantity > 0)) {
                console.log(
                    `❌ Excluded from Scheduled: ${p.name} | ` +
                    `isActive=${p.isActive} | ` +
                    `isSerialized=${p.isSerialized} | ` +
                    `defaultQuantity=${p.defaultQuantity}`
                );
            }
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
        // qty starts at defaultQuantity (min 1 for non-serialized).
        // selected = false always — user must interact to select.
        this.unscheduledProducts = baseProducts
            .filter(p => p.isActive)
            .map(p => ({
            ...p,
            qty:            p.isSerialized ? 1 : (Number(p.defaultQuantity) > 0 ? Number(p.defaultQuantity) : 1),
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
        if (this._pendingPrliSync) return;
        if (this.isSaving && !this._allowSelectionApplyDuringSave) {
            if (this.isScheduledTab) {
                console.log('⏭️ Skip selection apply — saving in progress');
            }
            return;
        }
        if (this.isScheduledTab && !this._allowSelectionApplyDuringSave) {
            if (this._scheduledSelectionDirty) {
                console.log('⏭️ Skip selection apply — preserve user selection (Scheduled)');
                return;
            }
            if (this.activePrId && !this.prliLoaded) {
                console.log('⏳ Skip selection apply — PRLI not loaded (Scheduled)');
                return;
            }
        }
        if (this.isUnscheduledTab && this.activePrId && !this.prliLoaded) {
            console.log('⏳ Skip selection apply — PRLI not loaded (Unscheduled)');
            return;
        }
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
        if (this.isScheduledTab) {
            this._scheduledSelectionDirty = false;
        }
    }

    // ───────── Unscheduled Logic ─────────
    // Apply saved PRLI selections and quantities to the unscheduled list
    _applyQuantitiesFromPrliMap() {
        if (this._pendingPrliSync) return;
        if (this.isUnscheduledTab &&
            this._unscheduledSelectionDirty &&
            !this._allowSelectionApplyDuringSave) {
            console.log('⏭️ Skip quantity apply — preserve user selection (Unscheduled)');
            return;
        }
        if (this.isUnscheduledTab && this.activePrId && !this.prliLoaded) {
            console.log('⏳ Skip quantity apply — PRLI not loaded (Unscheduled)');
            return;
        }
        if (this.isSaving && !this._allowSelectionApplyDuringSave) {
            console.log('⏭️ Skip quantity apply — save in progress');
            return;
        }
        if (this.unscheduledProducts.length === 0) return;

        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            const hasPrli = p.product2Id && this.prliMap.has(p.product2Id);

            // Saved PRLI exists → restore saved qty from server.
            // No PRLI → show defaultQuantity in input (display value; not a selection trigger).
            // selected is still controlled by hasPrli, so displaying defaultQuantity
            // does NOT cause the product to be included in PRLI sync.
            // hasPrli: restore saved PRLI qty (may be 0 if server stored 0).
            // No PRLI → show defaultQuantity (min 1 for non-serialized).
            const savedQty = hasPrli ? this.prliQtyMap.get(p.product2Id) : undefined;
            const fallbackQty = p.isSerialized ? 1 : (Number(p.defaultQuantity) > 0 ? Number(p.defaultQuantity) : 1);
            const qty      = (savedQty !== null && savedQty !== undefined)
                ? savedQty
                : fallbackQty;
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
        if (this.isUnscheduledTab) {
            this._unscheduledSelectionDirty = false;
        }
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
                                (p.productCode && p.productCode.toLowerCase().includes(term))
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
        if (this.isScheduledTab) {
            this._scheduledSelectionDirty = true;
        }
    }

    get selectedProducts()  { return this.allProducts.filter(p => p.selected); }
    get hasSelections()     { return this.selectedProducts.length > 0; }
    get selectedCount()     { return this.selectedProducts.length; }

    // True when at least one unscheduled product is selected.
    // Qty validation remains in save/submit logic; this getter controls only button state.
    get hasUnscheduledSelections() {
        return this.unscheduledProducts.some(
            p => p.product2Id && p.selected
        );
    }

    // Tab-aware: Unscheduled uses selection-only button gating.
    // Quantity-specific checks are enforced on save/submit.
    // Scheduled retains the original allProducts-based check unchanged.
    get isActionsDisabled() {
        if (this.isSubmitted) return true;
        if (this.isUnscheduledTab) return !this.hasUnscheduledSelections;
        return !this.hasSelections;
    }

    // isSubmitted drives UI lock:
    //   Scheduled: locked ONLY when status = statusSubmit.
    //   Closed statuses (Closed-Rejected, Closed-Fulfilled) are terminal but must
    //   NOT lock the form — they allow new PR creation. This is the mobile safety
    //   valve: if the wire cache is stale and activePrStatus is still 'Submitted'
    //   after the server moved it to a closed status, returning false here prevents
    //   the form from locking. _checkAndResetIfClosed handles the proper reset.
    //   Unscheduled: NEVER locked — submit clears activePrId so user can
    //   immediately start a new Unscheduled PR without any restriction.
    get isSubmitted() {
        if (this.isUnscheduledTab) {
            return false;
        }
        if (!this.activePrStatus) return false;
        // Closed statuses: form must stay unlocked so the user can create a new PR.
        // statusClosedRejected and statusClosedFulfilled are module-level constants
        // so this check is safe even before isConfigReady is true.
        if (this.activePrStatus === this.statusClosedRejected ||
            this.activePrStatus === this.statusClosedFulfilled) {
            return false;
        }
        return this.isConfigReady && this.activePrStatus === this.statusSubmit;
    }

    // ───────── Unscheduled Logic ─────────
    // Unscheduled Tab Logic (+ / - quantity handling)
    get hasUnscheduledProducts() { return this.unscheduledProducts.length > 0; }
    get filteredUnscheduledProducts() {
        const term = this.searchTerm ? this.searchTerm.toLowerCase() : null;
        const base = term
            ? this.unscheduledProducts.filter(p =>
                                (p.name        && p.name.toLowerCase().includes(term)) ||
                                (p.productCode && p.productCode.toLowerCase().includes(term))
              )
            : this.unscheduledProducts;
        // Same sort rule as Scheduled: selected first, then A–Z by name.
        return this._sortProducts(base);
    }
    get hasFilteredUnscheduledProducts() { return this.filteredUnscheduledProducts.length > 0; }

    handleUnscheduledToggle(event) {
        if (this.isSubmitted) return;

        const productId = event.currentTarget.dataset.productid;
        this._unscheduledSelectionDirty = true;

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
        const current   = this.unscheduledProducts.find(p => p.id === productId);

        if (!current) return;
        if (!current.selected) {
            event.target.value = current.qty !== null && current.qty !== undefined ? current.qty : '';
            return;
        }

        // Allow empty string while the user is mid-edit (e.g. cleared via backspace).
        // Store it as-is so the input stays stable; treat it as 0 only for numeric ops.
        const isEmpty   = rawValue === '' || rawValue === null;
        if (!isEmpty && !/^\d+$/.test(String(rawValue))) {
            event.target.value = current.qty !== null && current.qty !== undefined ? current.qty : '';
            return;
        }
        const nextValue = isEmpty ? 0 : Number(rawValue);

        if (!isEmpty && (isNaN(nextValue) || nextValue < 0)) {
            event.target.value = current.qty !== null && current.qty !== undefined ? current.qty : '';
            return;
        }

        this._unscheduledSelectionDirty = true;
        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;

            // Selection is INDEPENDENT of qty.
            // - If the product was never touched, the first qty edit auto-selects it
            //   (mirrors the previous +/- behaviour: typing a value implies intent).
            // - Once already selected (or already deselected by an explicit toggle),
            //   the selected state is preserved unchanged — qty edits do NOT flip it.
            // Explicit deselection is only possible via handleUnscheduledToggle (row tap).
            return {
                ...p,
                qty:            isEmpty ? rawValue : nextValue, // preserve '' during editing
                isUserModified: true,
                selected:       p.selected,
                rowClass:       p.selected ? 'product-row selected' : 'product-row'
            };
        });
    }

    handleQtyKeyDown(event) {
        const allowedKeys = [
            'Backspace', 'Delete', 'Tab',
            'ArrowLeft', 'ArrowRight',
            'ArrowUp', 'ArrowDown',
            'Home', 'End'
        ];

        if (allowedKeys.includes(event.key)) return;
        if (/^\d$/.test(event.key)) return;

        event.preventDefault();
    }

    handleQtyClick(event) {
        event.stopPropagation();
    }

    handleQtyIncrement(event) {
        event.stopPropagation();
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        let didChange = false;
        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;
            if (!p.selected) return p;
            didChange = true;
            // Increment always results in qty >= 1.
            const nextValue = Number(p.qty || 0) + 1;
            return {
                ...p,
                qty:            nextValue,
                isUserModified: true,
                selected:       p.selected,
                rowClass:       p.selected ? 'product-row selected' : 'product-row'
            };
        });
        if (didChange) {
            this._unscheduledSelectionDirty = true;
        }
    }

    handleQtyDecrement(event) {
        event.stopPropagation();
        if (this.isSubmitted) return;
        const productId = event.currentTarget.dataset.productid;
        let didChange = false;
        this.unscheduledProducts = this.unscheduledProducts.map(p => {
            if (p.id !== productId) return p;
            if (!p.selected) return p;
            didChange = true;
            // Clamp to 0 but do NOT auto-deselect when reaching 0.
            // Selection is controlled exclusively by handleUnscheduledToggle (row tap).
            const next = Math.max(0, Number(p.qty || 0) - 1);
            return {
                ...p,
                qty:            next,
                isUserModified: true,
                selected:       p.selected,
                rowClass:       p.selected ? 'product-row selected' : 'product-row'
            };
        });
        if (didChange) {
            this._unscheduledSelectionDirty = true;
        }
    }


    // ───────── Shared Logic ─────────
    _isNeedByDateInvalid() {
        return this.isUnscheduledTab &&
            this.needByDate &&
            this.needByDate < this.todayDate;
    }

    _blockIfInvalidNeedByDate() {
        if (!this._isNeedByDateInvalid()) return false;
        this.dispatchEvent(new ShowToastEvent({
            title: 'Invalid Date',
            message: 'Please select today or a future date.',
            variant: 'error'
        }));
        this.needByDate = this.originalNeedByDate || '';
        return true;
    }

    handleNeedByDateChange(event) {
        const selectedDate = event.target.value;

        if (this.isUnscheduledTab && selectedDate && selectedDate < this.todayDate) {
            event.target.setCustomValidity('Please select today or a future date.');
            event.target.reportValidity();
            const lastValid = this.originalNeedByDate || '';
            this.needByDate = lastValid;
            event.target.value = lastValid;
            event.target.setCustomValidity('');
            return;
        }

        event.target.setCustomValidity('');
        this.needByDate = selectedDate || null;
    }

    // ── Clear ─────────────────────────────────────────────────────────────
    handleClear() {
        this.allProducts = this.allProducts.map(p => ({
            ...p, selected: false, rowClass: 'product-row'
        }));
        if (this.isScheduledTab) {
            this._scheduledSelectionDirty = true;
        }
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

    _applyDraftPrInfoFromWire() {
        const data = this._draftPrWire?.data;
        if (!data) return;
        const errorEdges = data?.uiapi?.query?.ErrorPr?.edges || [];
        const draftEdges = data?.uiapi?.query?.DraftPr?.edges || [];
        const submittedEdges = data?.uiapi?.query?.SubmittedPr?.edges || [];
        const existingPr = errorEdges[0]?.node || draftEdges[0]?.node || submittedEdges[0]?.node || null;
        if (!existingPr) return;

        const nextNumber = existingPr?.ProductRequestNumber?.value || '';
        const nextStatus = existingPr?.Status?.value || this.statusDefault;
        const resolvedNumber = nextNumber || this.activePrNumber || '';

        if (this.isScheduledTab) {
            if (!(this.activePrStatus === this.statusSubmit && nextStatus === this.statusDefault)) {
                this.activeScheduledPrStatus = nextStatus;
                this.activePrStatus = nextStatus;
            }
            this.activeScheduledPrNumber = resolvedNumber;
        } else {
            this.activeUnscheduledPrNumber = resolvedNumber;
        }
        this.activePrNumber = resolvedNumber;
    }

    _serializeForDebug(value) {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }

    _logBeforeDmlContext(operationLabel, payload = {}) {
        console.log('===== BEFORE DML START =====');
        console.log('Operation: ' + operationLabel);
        console.log('Running User Id: ' + USER_ID);
        console.log('Running User Profile Context');
        console.log('Logged-in User Profile: unavailable in LWC context');
        console.log('Custom Permission Access Check');
        console.log('Warehouse Manager Flow Triggered');
        console.log('Service Resource Id: ' + (this.serviceResourceId || ''));
        console.log('Technician Selected Id: ' + (this.externalServiceResourceId || ''));
        console.log('Product Request Record: ' + this._serializeForDebug(payload.productRequestRecord));
        console.log('Product Line Items: ' + this._serializeForDebug(payload.productLineItems));
        console.log('Product Items to Update: ' + this._serializeForDebug(payload.productItemsToUpdate));
        console.log('Additional DML Context: ' + this._serializeForDebug(payload.additionalContext));
        console.log('===== BEFORE DML END =====');
    }

    _logLdsError(operationLabel, error, context = {}) {
        const body = error?.body || {};
        const output = body?.output || {};
        const topLevelErrors = Array.isArray(body) ? body : [];
        const outputErrors = output?.errors || [];
        const pageErrors = output?.pageErrors || [];
        const fieldErrors = output?.fieldErrors || {};

        console.error('===== DML ERROR START =====');
        console.error('Operation: ' + operationLabel);
        console.error('Context: ' + this._serializeForDebug(context));
        console.error('Status: ' + (error?.status || body?.statusCode || 'UNKNOWN'));
        console.error('Message: ' + (body?.message || error?.message || 'UNKNOWN'));

        for (const err of [...topLevelErrors, ...outputErrors, ...pageErrors]) {
            console.error('Status Code: ' + (err?.errorCode || err?.statusCode || 'UNKNOWN'));
            console.error('Message: ' + (err?.message || 'UNKNOWN'));
            console.error('Fields: ' + this._serializeForDebug(err?.fields || []));
        }

        Object.keys(fieldErrors).forEach((fieldName) => {
            const errs = fieldErrors[fieldName] || [];
            for (const err of errs) {
                console.error('Status Code: ' + (err?.errorCode || 'UNKNOWN'));
                console.error('Message: ' + (err?.message || 'UNKNOWN'));
                console.error('Fields: ' + this._serializeForDebug([fieldName]));
            }
        });

        console.error('Raw Error Payload: ' + this._serializeForDebug(error));
        console.error('===== DML ERROR END =====');
    }

    async _submitPrRecord(prId) {
        if (this.activePrStatus === this.statusErrorInSubmission) {
            const resetFields = {};
            resetFields[PR_ID.fieldApiName] = prId;
            resetFields[PR_STATUS.fieldApiName] = this.statusDefault;
            resetFields[PR_SUBMIT_DATE.fieldApiName] = null;
            this._logBeforeDmlContext('ProductRequest reset before submit', {
                productRequestRecord: resetFields,
                additionalContext: { activePrStatus: this.activePrStatus }
            });
            try {
                await updateRecord({ fields: resetFields });
            } catch (e) {
                this._logLdsError('ProductRequest reset before submit', e, {
                    prId,
                    fields: resetFields
                });
                throw e;
            }
        }

        const submitDateTime = new Date().toISOString();
        const submitFields = {};
        submitFields[PR_ID.fieldApiName] = prId;
        submitFields[PR_STATUS.fieldApiName] = this.statusSubmit;
        submitFields[PR_SUBMIT_DATE.fieldApiName] = submitDateTime;
        submitFields['DTVSCM_Integration_Status__c'] = 'Submitted';
        this._logBeforeDmlContext('ProductRequest submit update', {
            productRequestRecord: submitFields,
            additionalContext: { submitDateTime }
        });
        try {
            await updateRecord({ fields: submitFields });
        } catch (e) {
            this._logLdsError('ProductRequest submit update', e, {
                prId,
                fields: submitFields
            });
            throw e;
        }
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
    async handleSave(options = {}) {
        const { suppressToast = false, initialPrStatus = null } = options;
        if (!this._ensureConfigReady()) return;
        if (this.isSubmitted) {
            if (!suppressToast) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Request Submitted',
                    message: 'This Product Request is submitted and can no longer be edited.',
                    variant: 'info'
                }));
            }
            return;
        }
        if (this._blockIfInvalidNeedByDate()) return;
        if (!this.isPrReady && !this.activePrId) {
            if (!suppressToast) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Please wait',
                    message: 'Loading existing Product Request...',
                    variant: 'info'
                }));
            }
            return;
        }

        // Unscheduled save guard: block save when any selected product has qty <= 0.
        // Show only the user-friendly validation toast and stop before save logic.
        if (this.isUnscheduledTab) {
            const hasSelectedWithZeroQty = this.unscheduledProducts.some(
                p => p.product2Id && p.selected && Number(p.qty || 0) <= 0
            );
            if (hasSelectedWithZeroQty) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Invalid Selection',
                    message: 'Please select product with quantity greater than zero.',
                    variant: 'warning'
                }));
                return;
            }
        }

        this.isSaving = true;
        try {
            const { delta, createErrors, updateErrors, deleteErrors } =
                await this._ensurePrAndSyncPrlis({ initialPrStatus });

            const hasSaveErrors = createErrors.length > 0 || updateErrors.length > 0 || deleteErrors.length > 0;
            if (this.isScheduledTab && !hasSaveErrors) {
                this._scheduledSelectionDirty = false;
            }
            if (this.isUnscheduledTab && !hasSaveErrors) {
                this._unscheduledSelectionDirty = false;
            }

            // ── STEP 5: Toast ─────────────────────────────────────────────
            if (!suppressToast) {
                if (!hasSaveErrors) {
                    const totalChanges = delta.created + delta.updated + delta.deleted;
                    let isNeedByDateChanged = false;
                    if (this.isUnscheduledTab) {
                        const nextNeedByDate = this.needByDate || '';
                        const originalNeedByDate = this.originalNeedByDate || '';
                        isNeedByDateChanged = nextNeedByDate !== originalNeedByDate;
                        if (isNeedByDateChanged) {
                            this.unscheduledOriginalNeedByDate = nextNeedByDate;
                            this.originalNeedByDate = nextNeedByDate;
                        }
                    }

                    const hasAnyChanges = totalChanges > 0 || isNeedByDateChanged;
                    if (!hasAnyChanges) {
                        this.dispatchEvent(new ShowToastEvent({
                            title: 'No Changes',
                            message: NO_CHANGES_MESSAGE,
                            variant: 'info'
                        }));
                    } else {
                        this.dispatchEvent(new ShowToastEvent({
                            title: '✅ Saved',
                            message: SAVE_MESSAGE,
                            variant: 'success'
                        }));
                    }
                } else {
                    const msg = [...createErrors, ...updateErrors, ...deleteErrors].join(' | ');
                    this.dispatchEvent(new ShowToastEvent({
                        title: 'Saved with Issues',
                        message: msg,
                        variant: 'warning', mode: 'sticky'
                    }));
                }
            }

        } catch (err) {
            if (this.isUnscheduledTab && err?.message === 'zero-qty') {
                return;
            }
            console.error('❌ Save failed:', err);
            this._logLdsError('handleSave', err, {
                activePrId: this.activePrId,
                activeTab: this.activeTab,
                isUnscheduledTab: this.isUnscheduledTab,
                selectedCount: this.selectedProducts?.length || 0,
                unscheduledSelectedCount: (this.unscheduledProducts || []).filter(p => p?.selected).length
            });
            if (!suppressToast) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Save Failed',
                    message: err?.body?.message || err.message,
                    variant: 'error', mode: 'sticky'
                }));
            }
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
    async _ensurePrAndSyncPrlis(options = {}) {
        const { initialPrStatus = null } = options;
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
            const prStatusValue = initialPrStatus || this.statusDefault;
            prFields[PR_STATUS.fieldApiName]          = prStatusValue;
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
                prFields[PR_NEED_BY_DATE.fieldApiName] = this._normalizeNeedByDateToUtc(this.needByDate);
            }
            this._applyRecordTypeId(prFields, this.prRecordTypeId, PR_RECORD_TYPE_ID);

            console.log('⚡ Creating ProductRequest...');
            this._logBeforeDmlContext('ProductRequest create', {
                productRequestRecord: prFields,
                productLineItems: this.selectedProducts,
                productItemsToUpdate: this.unscheduledProducts,
                additionalContext: {
                    sourceLocationId: this.sourceLocationId,
                    destinationLocationId: this.destinationLocationId,
                    shipmentType: prFields[PR_SHIPMENT_TYPE.fieldApiName]
                }
            });
            let prResult;
            try {
                prResult = await createRecord({
                    apiName: PR_OBJECT.objectApiName,
                    fields: prFields
                });
            } catch (e) {
                this._logLdsError('ProductRequest create', e, {
                    fields: prFields,
                    activeTab: this.activeTab
                });
                throw e;
            }
            this.activePrId     = prResult.id;
            this.activePrStatus = prStatusValue;
            // Placeholder so UI shows a number immediately while the server assigns it.
            this.activePrNumber = 'Generating...';
            console.log('✅ ProductRequest created:', this.activePrId);
            this._storeActiveTabState();
            // DO NOT call _refreshPrData() here.
            // Doing so fires wiredDraftPR → _processDraftPrData → _applyActiveTabState
            // which resets prliMap=new Map() and calls _applyQuantitiesFromPrliMap()
            // setting ALL unscheduledProducts to qty=0, selected=false — wiping the
            // user's selection BEFORE _syncUnscheduledSelections runs.
            // The PRLI wire fires reactively when activePrId changes; STEP 4 handles
            // the final refresh after sync completes.
        } else if (this.isUnscheduledTab) {
            const nextNeedByDate = this.needByDate || '';
            const originalNeedByDate = this.originalNeedByDate || '';
            if (nextNeedByDate !== originalNeedByDate) {
                const prUpdateFields = {};
                prUpdateFields[PR_ID.fieldApiName] = this.activePrId;
                prUpdateFields[PR_NEED_BY_DATE.fieldApiName] = this._normalizeNeedByDateToUtc(nextNeedByDate);
                this._logBeforeDmlContext('ProductRequest NeedByDate update', {
                    productRequestRecord: prUpdateFields,
                    additionalContext: { nextNeedByDate, originalNeedByDate }
                });
                try {
                    await updateRecord({ fields: prUpdateFields });
                } catch (e) {
                    this._logLdsError('ProductRequest NeedByDate update', e, {
                        fields: prUpdateFields,
                        activePrId: this.activePrId
                    });
                    throw e;
                }
            }
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

        const totalChanges = delta.created + delta.updated + delta.deleted;
        if (totalChanges > 0) {
            let expectedIds = [];
            if (this.isScheduledTab) {
                expectedIds = this.selectedProducts
                    .map((p) => p.product2Id)
                    .filter(Boolean);
            } else if (this.isUnscheduledTab) {
                expectedIds = this.unscheduledProducts
                    .filter((p) => p.product2Id && p.selected && Number(p.qty || 0) > 0)
                    .map((p) => p.product2Id);
            }
            this._expectedPrliProductIds = new Set(expectedIds);
            this._pendingPrliSync = true;
            this._pendingPrliSyncStartedAt = Date.now();
        } else {
            this._expectedPrliProductIds = null;
            this._pendingPrliSync = false;
            this._pendingPrliSyncStartedAt = null;
        }

        // ── STEP 4: Refresh PR + PRLI wires so UI reflects saved state.
        // isSaving=true blocks wiredPrli from calling _applyQuantitiesFromPrliMap
        // mid-refresh. After the wire settles, we call it explicitly here
        // with the updated prliMap so deselected products (qty=0) are not restored.
        await this._refreshPrData();
        await new Promise(resolve => setTimeout(resolve, 200));
        this._applyDraftPrInfoFromWire();
        this._applySavedSnapshotIfOffline();
        this._applyPrliStateFromCurrentMaps();
        this._schedulePostSavePrliRefreshes();

        return { delta, createErrors, updateErrors, deleteErrors };
    }

    // ───────── Scheduled Logic ─────────
    _runPrliDmlBatches(items, worker, startIndex = 0, results = []) {
        if (startIndex >= items.length) {
            return Promise.resolve(results);
        }
        const batch = items.slice(startIndex, startIndex + PRLI_DML_BATCH_SIZE);
        return Promise.all(batch.map(worker)).then((batchResults) => {
            results.push(...batchResults);
            return this._runPrliDmlBatches(
                items,
                worker,
                startIndex + PRLI_DML_BATCH_SIZE,
                results
            );
        });
    }

    async _syncScheduledSelections() {
        // Step 2: Compute delta between UI and server
        const existingMap = this.prliMap;          // Map(Product2Id → PRLI.Id)
        const existingIds = new Set(existingMap.keys());

        const selected    = this.selectedProducts;
        const selectedByProduct2Id = new Map();
        const selectedP2Ids = new Set();
        for (const product of selected) {
            if (!product.product2Id) continue;
            selectedByProduct2Id.set(product.product2Id, product);
            selectedP2Ids.add(product.product2Id);
        }

        // Products selected in UI but NOT yet on server → need createRecord
        const toCreate = [];
        for (const pid of selectedP2Ids) {
            if (!existingIds.has(pid)) {
                toCreate.push(pid);
            }
        }
        // Products on server but NOT selected in UI → need deleteRecord
        const toDelete = [];
        for (const pid of existingIds) {
            if (!selectedP2Ids.has(pid)) {
                toDelete.push(pid);
            }
        }

        console.log(`📊 Save delta — Create: ${toCreate.length}, Delete: ${toDelete.length}`);

        const createErrors = (await this._runPrliDmlBatches(toCreate, async (pid) => {
            const p = selectedByProduct2Id.get(pid);
            if (!p) return null;
            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = (p.defaultQuantity && Number(p.defaultQuantity) > 0)
                    ? Number(p.defaultQuantity) : 1;
                this._applyRecordTypeId(prliFields, this.prliRecordTypeId, PRLI_RECORD_TYPE_ID);
                if (this.sourceLocationId) {
                    prliFields['SourceLocationId'] = this.sourceLocationId;
                }
                if (this.destinationLocationId) {
                    prliFields['DestinationLocationId'] = this.destinationLocationId;
                }
                if (p.quantityUOM !== null && p.quantityUOM !== undefined) {
                    prliFields['QuantityUnitOfMeasure'] = p.quantityUOM;
                }

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.defaultQuantity})`);
                this._logBeforeDmlContext('ProductRequestLineItem create (scheduled)', {
                    productRequestRecord: { Id: this.activePrId },
                    productLineItems: [p],
                    additionalContext: { product2Id: pid, prliFields }
                });
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);

                this.prliMap.set(pid, prliResult.id);
                this.prliQtyMap.set(pid, prliFields[PRLI_QTY_REQUESTED.fieldApiName]);
            } catch (e) {
                console.error(`❌ PRLI create failed: ${p.name}`, e);
                this._logLdsError('ProductRequestLineItem create (scheduled)', e, {
                    product2Id: pid,
                    productName: p?.name,
                    fields: p
                });
                return `${p.name}: ${e?.body?.message || e.message}`;
            }
            return null;
        })).filter(Boolean);

        const deleteErrors = (await this._runPrliDmlBatches(toDelete, async (pid) => {
            try {
                const recId = existingMap.get(pid);
                if (recId) {
                    console.log(`🗑️ Deleting PRLI for Product2Id: ${pid} (${recId})`);
                    this._logBeforeDmlContext('ProductRequestLineItem delete (scheduled)', {
                        productRequestRecord: { Id: this.activePrId },
                        additionalContext: { product2Id: pid, prliId: recId }
                    });
                    await deleteRecord(recId);
                    this.prliMap.delete(pid);
                    this.prliQtyMap.delete(pid);
                }
            } catch (e) {
                console.error(`❌ PRLI delete failed: ${pid}`, e);
                this._logLdsError('ProductRequestLineItem delete (scheduled)', e, {
                    product2Id: pid,
                    prliId: existingMap.get(pid)
                });
                return `Delete ${pid}: ${e?.body?.message || e.message}`;
            }
            return null;
        })).filter(Boolean);

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
        const selectedByProduct2Id = new Map();
        const selectedIds = new Set();
        for (const product of this.unscheduledProducts) {
            const pid = product.product2Id;
            const qty = Math.max(0, Number(product.qty || 0));
            if (!pid || !product.selected || qty <= 0) continue;
            selectedByProduct2Id.set(pid, { product, qty });
            selectedIds.add(pid);
        }

        const toCreate = [];
        for (const pid of selectedIds) {
            if (!existingIds.has(pid)) {
                toCreate.push(pid);
            }
        }

        const toDelete = [];
        for (const pid of existingIds) {
            if (!selectedIds.has(pid)) {
                toDelete.push(pid);
            }
        }

        const toUpdate = [];
        for (const pid of selectedIds) {
            if (existingIds.has(pid) && Number(existingQty.get(pid)) !== selectedByProduct2Id.get(pid).qty) {
                toUpdate.push(pid);
            }
        }

        console.log(`📊 Save delta — Create: ${toCreate.length}, Update: ${toUpdate.length}, Delete: ${toDelete.length}`);

        const createErrors = (await this._runPrliDmlBatches(toCreate, async (pid) => {
            const selectedItem = selectedByProduct2Id.get(pid);
            if (!selectedItem) return null;
            const { product: p, qty } = selectedItem;

            // Idempotency guard: never create if PRLI already exists in local map.
            // Protects against duplicate creates if wire fires and updates prliMap
            // mid-loop, or if this method is called twice concurrently.
            if (this.prliMap.has(pid)) {
                console.warn(`⚠️ PRLI already exists for product ${p.name} — skipping create, will update instead`);
                // Treat as an update if qty differs
                const savedQty = this.prliQtyMap.get(pid);
                if (savedQty !== qty) {
                    try {
                        const upFields = {};
                        upFields.Id = this.prliMap.get(pid);
                        upFields[PRLI_QTY_REQUESTED.fieldApiName] = qty;
                        this._logBeforeDmlContext('ProductRequestLineItem update (idempotency path)', {
                            productRequestRecord: { Id: this.activePrId },
                            productLineItems: [p],
                            additionalContext: { upFields }
                        });
                        await updateRecord({ fields: upFields });
                        this.prliQtyMap.set(pid, qty);
                        console.log(`✅ PRLI updated (idempotency path): ${p.name} qty=${qty}`);
                    } catch (e) {
                        this._logLdsError('ProductRequestLineItem update (idempotency path)', e, {
                            product2Id: pid,
                            productName: p?.name
                        });
                        return `${p.name}: ${e?.body?.message || e.message}`;
                    }
                }
                return null;
            }

            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                prliFields[PRLI_STATUS.fieldApiName]        = this.statusDefault;
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = qty;
                this._applyRecordTypeId(prliFields, this.prliRecordTypeId, PRLI_RECORD_TYPE_ID);
                if (this.sourceLocationId) {
                    prliFields['SourceLocationId'] = this.sourceLocationId;
                }
                if (this.destinationLocationId) {
                    prliFields['DestinationLocationId'] = this.destinationLocationId;
                }
                if (p.quantityUOM !== null && p.quantityUOM !== undefined) {
                    prliFields['QuantityUnitOfMeasure'] = p.quantityUOM;
                }

                console.log(`⚡ Creating PRLI: ${p.name} (qty: ${qty})`);
                this._logBeforeDmlContext('ProductRequestLineItem create (unscheduled)', {
                    productRequestRecord: { Id: this.activePrId },
                    productLineItems: [p],
                    additionalContext: { product2Id: pid, prliFields }
                });
                const prliResult = await createRecord({
                    apiName: PRLI_OBJECT.objectApiName,
                    fields: prliFields
                });
                console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);

                this.prliMap.set(pid, prliResult.id);
                this.prliQtyMap.set(pid, qty);
            } catch (e) {
                console.error(`❌ PRLI create failed: ${p.name}`, e);
                this._logLdsError('ProductRequestLineItem create (unscheduled)', e, {
                    product2Id: pid,
                    productName: p?.name,
                    qty
                });
                return `${p.name}: ${e?.body?.message || e.message}`;
            }
            return null;
        })).filter(Boolean);

        const updateErrors = (await this._runPrliDmlBatches(toUpdate, async (pid) => {
            const selectedItem = selectedByProduct2Id.get(pid);
            if (!selectedItem) return null;
            const { product: p, qty } = selectedItem;
            try {
                const prliFields = {};
                prliFields.Id = existingMap.get(pid);
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = qty;

                console.log(`✏️ Updating PRLI: ${p.name} (qty: ${qty})`);
                this._logBeforeDmlContext('ProductRequestLineItem update (unscheduled)', {
                    productRequestRecord: { Id: this.activePrId },
                    productLineItems: [p],
                    additionalContext: { prliFields }
                });
                await updateRecord({ fields: prliFields });
                this.prliQtyMap.set(pid, qty);
            } catch (e) {
                console.error(`❌ PRLI update failed: ${p.name}`, e);
                this._logLdsError('ProductRequestLineItem update (unscheduled)', e, {
                    product2Id: pid,
                    productName: p?.name,
                    prliId: existingMap.get(pid)
                });
                return `${p.name}: ${e?.body?.message || e.message}`;
            }
            return null;
        })).filter(Boolean);

        const deleteErrors = (await this._runPrliDmlBatches(toDelete, async (pid) => {
            try {
                const recId = existingMap.get(pid);
                if (recId) {
                    console.log(`🗑️ Deleting PRLI for Product2Id: ${pid} (${recId})`);
                    this._logBeforeDmlContext('ProductRequestLineItem delete (unscheduled)', {
                        productRequestRecord: { Id: this.activePrId },
                        additionalContext: { product2Id: pid, prliId: recId }
                    });
                    await deleteRecord(recId);
                    this.prliMap.delete(pid);
                    this.prliQtyMap.delete(pid);
                }
            } catch (e) {
                console.error(`❌ PRLI delete failed: ${pid}`, e);
                this._logLdsError('ProductRequestLineItem delete (unscheduled)', e, {
                    product2Id: pid,
                    prliId: existingMap.get(pid)
                });
                return `Delete ${pid}: ${e?.body?.message || e.message}`;
            }
            return null;
        })).filter(Boolean);

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
                this._logBeforeDmlContext('Resource Product quantity update', {
                    productItemsToUpdate: [{ resourceProductId: rpId, quantity: newQty }]
                });
                await updateRecord({ fields });
                console.log(`✅ ResourceProduct qty updated: ${rpId}`);
            } catch (e) {
                console.error(`❌ ResourceProduct qty update failed: ${rpId}`, e);
                this._logLdsError('Resource Product quantity update', e, {
                    resourceProductId: rpId,
                    quantity: newQty
                });
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
    //   - Direct Submit: _ensurePrAndSyncPrlis → status update → reset
    //   - No prior Save required. Validation (zero-qty guard) runs inside
    //     _ensurePrAndSyncPrlis, so invalid selections are blocked here too.
    //   - Form resets after submit so user can immediately create a new PR.
    //   - isSubmitted getter always returns false for Unscheduled tab.
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        const confirmed = await LightningConfirm.open({
            message: 'Are you sure you want to submit request?',
            variant: 'headerless',
            label: 'Confirm Submission'
        });

        if (!confirmed) return;

        await this._handleSubmitConfirmed();
    }

    async _handleSubmitConfirmed() {
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
        if (this._blockIfInvalidNeedByDate()) return;

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
                console.log('⚡ Submitting Unscheduled PR:', this.activePrId);
                await this._submitPrRecord(this.activePrId);
                console.log('✅ Unscheduled PR submitted');

                // Reset state so user can create a new Unscheduled PR immediately.
                // Do NOT lock the form — isSubmitted always returns false here.
                const submittedId = this.activePrId;
                this.activeUnscheduledPrId     = null;
                this.activeUnscheduledPrStatus = this.statusDefault;
                this.activeUnscheduledPrNumber = '';
                this.unscheduledNeedByDate     = '';
                this.unscheduledOriginalNeedByDate = '';
                this.prliMap                   = new Map();
                this.prliQtyMap                = new Map();
                this._pendingQtyChanges        = new Map();
                this._applyActiveTabState();

                // Reset to clean slate — matches initial build state exactly.
                this.unscheduledProducts = this.unscheduledProducts.map(p => ({
                    ...p,
                    qty:            p.isSerialized ? 1 : (Number(p.defaultQuantity) > 0 ? Number(p.defaultQuantity) : 1),
                    isUserModified: false,
                    selected:       false,
                    rowClass:       'product-row'
                }));

                // Force wire to re-evaluate. With FIX 1 in _processDraftPrData,
                // the now-Submitted PR will be ignored → activePrId stays null
                // → user can immediately create a new Unscheduled PR.
                await this._refreshPrData();

                console.log('✅ Unscheduled PR submitted:', submittedId, '— form reset for new PR');

                this.dispatchEvent(new ShowToastEvent({
                    title: '✅ Submitted',
                    message: SUBMIT_MESSAGE,
                    variant: 'success'
                }));
                this.dispatchEvent(new CustomEvent('gohome'));

            } catch (e) {
                // Validation errors ('zero-qty', 'nothing-to-save') already toasted
                // inside _ensurePrAndSyncPrlis — only surface unexpected errors here.
                if (e?.message !== 'zero-qty' && e?.message !== 'nothing-to-save') {
                    console.error('❌ Unscheduled Submit failed:', e);
                    this._logLdsError('handleSubmit unscheduled', e, {
                        activePrId: this.activePrId,
                        activeTab: this.activeTab
                    });
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
        await this.handleSave({ suppressToast: true, initialPrStatus: this.statusSubmit });

        if (!this.activePrId) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Submit Blocked',
                message: 'Could not create Product Request.',
                variant: 'error'
            }));
            return;
        }

        try {
            console.log('⚡ Submitting PR:', this.activePrId);
            await this._submitPrRecord(this.activePrId);
            console.log('✅ PR submitted');

            // ── SCHEDULED: lock UI + offline-safe state update ────────────
            // Set activePrStatus immediately so isSubmitted reflects the new
            // state without waiting for the wire to re-fire.
            this.activePrStatus = this.statusSubmit;
            this.activeScheduledPrStatus = this.statusSubmit;
            console.log('STATUS AFTER SUBMIT:', this.activePrStatus);

            // Write the new status into the tab-slot backing store immediately.
            // If wiredDraftPR re-fires with stale cached data (common on mobile),
            // _applyActiveTabState will restore from this slot — which now holds
            // the correct 'Submitted' status instead of the old draft value.
            this._storeActiveTabState();

            this.allProducts = this.allProducts.map(p => ({
                ...p,
                rowClass: p.selected ? 'product-row selected' : 'product-row'
            }));

            // Delayed second refresh — works around mobile GraphQL cache TTL.
            // The first refresh (in _ensurePrAndSyncPrlis STEP 4) may return
            // stale data on mobile. After 2 seconds the server has propagated
            // the status change and the wire returns fresh data, allowing
            // _processDraftPrData to run the closed-status reset when the user
            // (or an admin) later changes the PR status to Closed externally.
            setTimeout(() => { this._refreshPrData().catch(() => {}); }, 2000);

            this.dispatchEvent(new ShowToastEvent({
                title: '✅ Submitted',
                message: SUBMIT_MESSAGE,
                variant: 'success'
            }));
             this.dispatchEvent(new CustomEvent('gohome'));

        } catch (e) {
            console.error('❌ Submit failed:', e);
            this._logLdsError('handleSubmit scheduled', e, {
                activePrId: this.activePrId,
                activeTab: this.activeTab
            });
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
        this._applyRecordTypeId(prFields, this.prRecordTypeId, PR_RECORD_TYPE_ID);

        this._logBeforeDmlContext('Offline queue ProductRequest create', {
            productRequestRecord: prFields,
            productLineItems: items
        });
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
                this._applyRecordTypeId(prliFields, this.prliRecordTypeId, PRLI_RECORD_TYPE_ID);
                this._logBeforeDmlContext('Offline queue ProductRequestLineItem create', {
                    productRequestRecord: { Id: prId },
                    productLineItems: [item],
                    additionalContext: { prliFields }
                });
                await createRecord({ apiName: PRLI_OBJECT.objectApiName, fields: prliFields });
                prliCount++;
            } catch (prliErr) {
                this._logLdsError('Offline queue ProductRequestLineItem create', prliErr, {
                    productRequestId: prId,
                    productName: item?.name,
                    product2Id: item?.product2Id
                });
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

    _ensureConfigReady() {
        return this.isConfigReady;
    }
}
