import { LightningElement, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';

// ─────────────────────────────────────────────────────────────────────────────
// API 1 — lightning/uiGraphQLApi
// Purpose: FETCH Product2 records via @wire
// Rule: Only for queries — mutations use uiRecordApi
// ─────────────────────────────────────────────────────────────────────────────
import { gql, graphql } from 'lightning/uiGraphQLApi';

// ─────────────────────────────────────────────────────────────────────────────
// API 2 — lightning/uiRecordApi
// Purpose: createRecord for ProductRequest + ProductRequestLineItem
// Used imperatively in handleSubmit + handleSyncQueue
// ─────────────────────────────────────────────────────────────────────────────
import { createRecord } from 'lightning/uiRecordApi';

// ProductRequest field schema tokens
import PR_OBJECT             from '@salesforce/schema/ProductRequest';
import PR_STATUS             from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION        from '@salesforce/schema/ProductRequest.Description';
import PR_NEED_BY_DATE       from '@salesforce/schema/ProductRequest.NeedByDate';
import PR_SHIPMENT_TYPE      from '@salesforce/schema/ProductRequest.ShipmentType';

// ProductRequestLineItem field schema tokens
import PRLI_OBJECT           from '@salesforce/schema/ProductRequestLineItem';
import PRLI_PR_ID            from '@salesforce/schema/ProductRequestLineItem.ParentId';
import PRLI_PRODUCT2_ID      from '@salesforce/schema/ProductRequestLineItem.Product2Id';
import PRLI_QTY_REQUESTED    from '@salesforce/schema/ProductRequestLineItem.QuantityRequested';
import PRLI_STATUS           from '@salesforce/schema/ProductRequestLineItem.Status';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY — fetch all active Product2 records
// Runs once on component load via @wire
// ─────────────────────────────────────────────────────────────────────────────
const GET_PRODUCTS_QUERY = gql`
    query GetActiveProducts {
        uiapi {
            query {
                Product2(
                    where: { IsActive: { eq: true } }
                    orderBy: { Name: { order: ASC } }
                    first: 100
                ) {
                    edges {
                        node {
                            Id
                            Name        { value }
                            ProductCode { value }
                            Family      { value displayValue }
                            Description { value }
                        }
                    }
                }
            }
        }
    }
`;

export default class DtvscmRequestForm extends LightningElement {

    // ─────────────────────────────────────────────────────────────────────
    // formFactor — 'Small' = FSL Mobile | 'Large' = Web Desktop
    // Used to apply different CSS class on shell + product list layout
    // ─────────────────────────────────────────────────────────────────────
    get isMobile()   { return FORM_FACTOR === 'Small';  }
    get isDesktop()  { return FORM_FACTOR === 'Large';  }

    // Shell class switches between mobile-shell and desktop-shell
    get shellClass() {
        return FORM_FACTOR === 'Small' ? 'shell shell-mobile' : 'shell shell-desktop';
    }

    // Product list class — single column mobile, two-column grid on desktop
    get productListClass() {
        return FORM_FACTOR === 'Small' ? 'product-list' : 'product-list product-list-desktop';
    }

    // Bottom bar — fixed on mobile, sticky inside card on desktop
    get bottomBarClass() {
        return FORM_FACTOR === 'Small' ? 'bottom-bar bottom-bar-mobile' : 'bottom-bar bottom-bar-desktop';
    }

    // ── Tab state ─────────────────────────────────────────────────────────
    @track activeTab = 'scheduled';

    get isScheduledTab()   { return this.activeTab === 'scheduled';   }
    get isUnscheduledTab() { return this.activeTab === 'unscheduled'; }

    get scheduledTabClass() {
        return this.activeTab === 'scheduled' ? 'tab-btn active' : 'tab-btn';
    }
    get unscheduledTabClass() {
        return this.activeTab === 'unscheduled' ? 'tab-btn active' : 'tab-btn';
    }

    handleTabSwitch(event) {
        this.activeTab = event.currentTarget.dataset.tab;
    }

    // ── Back button — fires CustomEvent('back') to parent ───────────────
    // Parent listens via: onback={handleBack}
    // Parent sets showProductRequest = false to hide this component
    handleBack() {
        this.dispatchEvent(new CustomEvent('back'));
    }

    // ── Search state ──────────────────────────────────────────────────────
    @track searchTerm = '';

    handleSearch(event)      { this.searchTerm = event.target.value; }
    handleClearSearch()      { this.searchTerm = ''; }

    // ── Network state ─────────────────────────────────────────────────────
    @track isOnline   = navigator.onLine;
    @track isSyncing  = false;
    @track offlineQueue = [];   // stores pending PR+PRLI creation operations

    // ─────────────────────────────────────────────────────────────────────
    // Lifecycle — attach browser online/offline event listeners
    // ─────────────────────────────────────────────────────────────────────
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
                title:   'Back Online!',
                message: `${this.offlineQueue.length} request(s) ready to sync.`,
                variant: 'info'
            }));
        }
    }

    handleOffline() {
        this.isOnline = false;
        this.dispatchEvent(new ShowToastEvent({
            title:   'You are Offline',
            message: 'Submissions will be queued and synced when online.',
            variant: 'warning',
            mode:    'sticky'
        }));
    }

    // Network computed
    get networkBannerClass() {
        return this.isOnline ? 'net-banner online' : 'net-banner offline';
    }
    get networkLabel() {
        return this.isOnline ? '🟢 Online' : '🔴 Offline — submissions will be queued';
    }
    get showSyncButton()    { return this.isOnline && this.offlineQueue.length > 0; }
    get syncLabel()         { return `Sync Now (${this.offlineQueue.length})`; }
    get hasPendingQueue()   { return this.offlineQueue.length > 0; }
    get pendingQueueCount() { return this.offlineQueue.length; }

    // ─────────────────────────────────────────────────────────────────────
    // GraphQL @wire — fetch Product2 records
    // Three states: loading / error / data
    // ─────────────────────────────────────────────────────────────────────
    @track allProducts   = [];   // full list from GraphQL
    @track isLoading     = true;
    @track hasWireError  = false;
    @track wireErrorMessage = '';

    @wire(graphql, { query: GET_PRODUCTS_QUERY })
    wiredProducts({ data, errors }) {

        // STATE 1 — still loading ⏳
        if (data === undefined && errors === undefined) {
            this.isLoading = true;
            return;
        }

        this.isLoading = false;

        // STATE 2 — GraphQL error ❌
        if (errors) {
            console.error('❌ GraphQL Wire Error:', JSON.stringify(errors));
            this.hasWireError      = true;
            this.wireErrorMessage  = errors.map(e => e.message).join(', ');
            return;
        }

        // STATE 3 — data passing ✅
        if (data) {
            console.log('✅ GraphQL Products received');
            this.hasWireError = false;

            // Map each edge into a flat product object
            // quantity = 0 means not selected
            this.allProducts = data.uiapi.query.Product2.edges.map(edge => ({
                id:          edge.node.Id,
                name:        edge.node.Name?.value        || '—',
                productCode: edge.node.ProductCode?.value || '—',
                family:      edge.node.Family?.displayValue || '—',
                description: edge.node.Description?.value || '',
                selected:    false,  // tap the row to select/deselect
                rowClass:    'product-row'
            }));
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Filtered products — search applied on top of allProducts
    // ─────────────────────────────────────────────────────────────────────
    get filteredProducts() {
        if (!this.searchTerm) return this.allProducts;
        const term = this.searchTerm.toLowerCase();
        return this.allProducts.filter(p =>
            p.name.toLowerCase().includes(term) ||
            p.productCode.toLowerCase().includes(term) ||
            p.family.toLowerCase().includes(term)
        );
    }

    get hasFilteredProducts() { return this.filteredProducts.length > 0; }

    // ─────────────────────────────────────────────────────────────────────
    // Tap to toggle — tapping a row selects or deselects it
    // Default quantity is 1 (set at submit time — no user input needed)
    // ─────────────────────────────────────────────────────────────────────
    handleProductToggle(event) {
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

    // Selected products — only rows where selected === true
    get selectedProducts() {
        return this.allProducts.filter(p => p.selected);
    }

    get hasSelections()     { return this.selectedProducts.length > 0; }
    get selectedCount()     { return this.selectedProducts.length; }
    get isActionsDisabled() { return !this.hasSelections; }  // ← LWC doesn't allow ! in template

    // ─────────────────────────────────────────────────────────────────────
    // CLEAR — resets all quantities back to 0, removes all selections
    // ─────────────────────────────────────────────────────────────────────
    handleClear() {
        // Deselect all rows — no DOM manipulation needed (no inputs)
        this.allProducts = this.allProducts.map(p => ({
            ...p,
            selected: false,
            rowClass: 'product-row'
        }));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SUBMIT — create ProductRequest + ProductRequestLineItems
    //
    // ONLINE:  createRecord (uiRecordApi) immediately
    // OFFLINE: push to offlineQueue, sync when back online
    //
    // Flow:
    //   1. createRecord(ProductRequest)  → get new PR Id
    //   2. loop selectedProducts:
    //      createRecord(ProductRequestLineItem) with ProductRequestId = PR Id
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        if (!this.hasSelections) return;

        // Snapshot selected products at time of submit
        const itemsToSubmit = this.selectedProducts.map(p => ({
            product2Id:  p.id,
            productName: p.name
            // quantityRequested intentionally omitted
            // sending 0 causes Salesforce validation error on PRLI
        }));

        if (this.isOnline) {
            // ── ONLINE: fire createRecord immediately ─────────────────────
            await this._createPRAndLineItems(itemsToSubmit);
        } else {
            // ── OFFLINE: push entire operation to queue ───────────────────
            this.offlineQueue = [
                ...this.offlineQueue,
                {
                    id:        Date.now(),
                    items:     itemsToSubmit,
                    timestamp: new Date().toISOString()
                }
            ];

            this.dispatchEvent(new ShowToastEvent({
                title:   'Queued Offline',
                message: `${itemsToSubmit.length} item(s) queued. Will create PR when online.`,
                variant: 'warning'
            }));

            // Clear selections after queuing
            this.handleClear();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SYNC QUEUE — called when user taps "Sync Now" after coming back online
    // Loops through offlineQueue and processes each batch
    // ─────────────────────────────────────────────────────────────────────
    async handleSyncQueue() {
        if (!this.isOnline || this.offlineQueue.length === 0) return;

        this.isSyncing = true;
        const queue    = [...this.offlineQueue];
        let   success  = 0;
        const failed   = [];

        for (const op of queue) {
            try {
                await this._createPRAndLineItems(op.items, true); // true = silent (no individual toasts)
                // Remove from queue on success
                this.offlineQueue = this.offlineQueue.filter(q => q.id !== op.id);
                success++;
            } catch (err) {
                console.error('❌ Sync failed for queued op:', err);
                failed.push(`${op.items.length} item(s) from ${new Date(op.timestamp).toLocaleTimeString()}`);
            }
        }

        this.isSyncing = false;

        if (failed.length === 0) {
            this.dispatchEvent(new ShowToastEvent({
                title:   '✅ Sync Complete',
                message: `${success} Product Request(s) created in Salesforce.`,
                variant: 'success'
            }));
        } else {
            this.dispatchEvent(new ShowToastEvent({
                title:   'Sync Partial',
                message: `${success} succeeded. Failed: ${failed.join(', ')}`,
                variant: 'error',
                mode:    'sticky'
            }));
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRIVATE — _createPRAndLineItems
    //
    // Step 1: createRecord(ProductRequest) via uiRecordApi
    // Step 2: loop items → createRecord(ProductRequestLineItem)
    //         each PRLI linked to the PR via ProductRequestId field
    // ─────────────────────────────────────────────────────────────────────
    async _createPRAndLineItems(items, silent = false) {

        // ── STEP 1: Create ProductRequest ─────────────────────────────────
        const prFields = {};
        prFields[PR_STATUS.fieldApiName]      = 'Draft';
        prFields[PR_DESCRIPTION.fieldApiName] = `Product Request — ${items.length} item(s) — ${new Date().toLocaleDateString()}`;

        const prRecordInput = {
            apiName: PR_OBJECT.objectApiName,
            fields:  prFields
        };

        console.log('⚡ createRecord — ProductRequest:', JSON.stringify(prRecordInput));
        const prResult = await createRecord(prRecordInput);
        const prId     = prResult.id;
        console.log('✅ ProductRequest created:', prId);

        // ── STEP 2: Create one PRLI per selected product ──────────────────
        let prliCount = 0;
        let prliErrors = [];

        for (const item of items) {
            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = prId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = item.product2Id;
                prliFields[PRLI_STATUS.fieldApiName]        = 'Draft';
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = 1;  // required — must be > 0

                const prliRecordInput = {
                    apiName: PRLI_OBJECT.objectApiName,
                    fields:  prliFields
                };

                console.log('⚡ createRecord — PRLI:', item.productName);
                await createRecord(prliRecordInput);
                prliCount++;
                console.log('✅ PRLI created for:', item.productName);

            } catch (prliErr) {
                console.error('❌ PRLI createRecord failed for', item.productName, ':', prliErr);
                prliErrors.push(`${item.productName}: ${prliErr?.body?.message || prliErr.message}`);
            }
        }

        // If any PRLI failed, show which ones
        if (prliErrors.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title:   'Some Line Items Failed',
                message: prliErrors.join(' | '),
                variant: 'error',
                mode:    'sticky'
            }));
        }

        console.log(`✅ Created PR ${prId} with ${prliCount} line item(s)`);

        if (!silent) {
            this.dispatchEvent(new ShowToastEvent({
                title:   '✅ Request Submitted!',
                message: `Product Request created with ${prliCount} line item(s).`,
                variant: 'success'
            }));
            // Clear selections after successful submit
            this.handleClear();
        }
    }
}
