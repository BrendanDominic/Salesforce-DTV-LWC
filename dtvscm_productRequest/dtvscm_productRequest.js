import { LightningElement, wire, track, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';

// ─────────────────────────────────────────────────────────────────────────────
// API 1 — lightning/uiGraphQLApi
// Purpose: FETCH Product2 + DTVSCM_Resource_Product__c records via @wire
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
// GraphQL QUERY 1 — fetch all active Product2 records
// ─────────────────────────────────────────��───────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 2 — fetch DTVSCM_Resource_Product__c records
// Gets the DTVSCM_Default_Quantity__c for each Product via the junction object
// ─────────────────────────────────────────────────────────────────────────────
const GET_RESOURCE_PRODUCTS_QUERY = gql`
    query GetResourceProducts {
        uiapi {
            query {
                Resource_Product__c(
                    first: 200
                    orderBy: { Name: { order: ASC } }
                ) {
                    edges {
                        node {
                            Id
                            Name                        { value }
                            DTVSCM_Default_Quantity__c  { value }
                            DTVSCM_Product__c           { value }
                            DTVSCM_ServiceResource__c   { value }
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
    // ─────────────────────────────────────────────────────────────────────
    get isMobile()   { return FORM_FACTOR === 'Small';  }
    get isDesktop()  { return FORM_FACTOR === 'Large';  }

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

    // ── Back button ───────────────────────────────────────────────────────
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
    @track offlineQueue = [];

    // ─────────────────────────────────────────────────────────────────────
    // Lifecycle
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
    // GraphQL @wire 1 — fetch Product2 records
    // ─────────────────────────────────────────────────────────────────────
    @track allProducts   = [];
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
            console.error('❌ GraphQL Wire Error (Product2):', JSON.stringify(errors));
            this.hasWireError      = true;
            this.wireErrorMessage  = errors.map(e => e.message).join(', ');
            return;
        }

        // STATE 3 — data received ✅
        if (data) {
            console.log('✅ GraphQL Products received');
            this.hasWireError = false;

            const productEdges = data?.uiapi?.query?.Product2?.edges;

            if (!productEdges) {
                console.warn('⚠️ Product2 edges is undefined — no products returned');
                this.allProducts = [];
                return;
            }

            this.allProducts = productEdges.map(edge => ({
                id:              edge.node.Id,
                name:            edge.node.Name?.value        || '—',
                productCode:     edge.node.ProductCode?.value || '—',
                family:          edge.node.Family?.displayValue || '—',
                description:     edge.node.Description?.value || '',
                defaultQuantity: 0,
                hasDefaultQty:   false,
                selected:        false,
                rowClass:        'product-row'
            }));

            // Merge default quantities if resource products already loaded
            this._mergeDefaultQuantities();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // GraphQL @wire 2 — fetch DTVSCM_Resource_Product__c records
    // Builds a map: Product2 Id → DTVSCM_Default_Quantity__c
    //
    // ⚠️ FIX: Added full null-safety checks for all three states:
    //    - still loading (data + errors both undefined)
    //    - errors returned
    //    - data returned but query result / edges might be undefined
    //      (happens when no Resource Product records exist yet)
    // ─────────────────────────────────────────────────────────────────────
    @track resourceProductMap = {};
    @track resourceProductsLoaded = false;

    @wire(graphql, { query: GET_RESOURCE_PRODUCTS_QUERY })
    wiredResourceProducts({ data, errors }) {

        // STATE 1 — still loading ⏳ (both undefined while wire is pending)
        if (data === undefined && errors === undefined) {
            return;
        }

        // STATE 2 — GraphQL error ❌
        if (errors) {
            console.error('❌ GraphQL Wire Error (Resource Products):', JSON.stringify(errors));
            // Don't crash the component — resource products are optional
            // Products will still load, just without default quantities
            this.resourceProductsLoaded = true;
            return;
        }

        // STATE 3 — data returned ✅
        if (data) {
            console.log('✅ GraphQL Resource Products wire returned data');

            // ── NULL-SAFETY: check every level before accessing .edges ──
            const queryResult = data?.uiapi?.query?.DTVSCM_Resource_Product__c;

            if (!queryResult || !queryResult.edges) {
                // No Resource Product records exist yet — this is perfectly fine
                console.warn('⚠️ No DTVSCM_Resource_Product__c records found — defaultQuantity will be 0 for all products');
                this.resourceProductMap = {};
                this.resourceProductsLoaded = true;
                // Still merge so products show "No default qty" gracefully
                this._mergeDefaultQuantities();
                return;
            }

            const edges = queryResult.edges;
            const map = {};

            edges.forEach(edge => {
                // Safety check each node's fields
                const productId  = edge.node?.DTVSCM_Product__c?.value;
                const defaultQty = edge.node?.DTVSCM_Default_Quantity__c?.value;

                if (productId && defaultQty != null) {
                    map[productId] = defaultQty;
                }
            });

            this.resourceProductMap = map;
            this.resourceProductsLoaded = true;
            console.log('📦 Resource Product Map built:', JSON.stringify(map));

            // Merge into allProducts if products already loaded
            this._mergeDefaultQuantities();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRIVATE — merge defaultQuantity from resourceProductMap into allProducts
    // Safe to call when either list is empty — just no-ops gracefully
    // ─────────────────────────────────────────────────────────────────────
    _mergeDefaultQuantities() {
        if (this.allProducts.length === 0) {
            return; // products not loaded yet — will be called again when they load
        }

        console.log('🔗 Merging default quantities into product list...');

        const hasResourceProducts = Object.keys(this.resourceProductMap).length > 0;

        this.allProducts = this.allProducts.map(p => {
            const dq = hasResourceProducts ? this.resourceProductMap[p.id] : undefined;
            return {
                ...p,
                defaultQuantity: dq != null ? dq : 0,
                hasDefaultQty:   dq != null && dq > 0
            };
        });

        console.log('✅ Merge complete. Products with default qty:',
            this.allProducts.filter(p => p.hasDefaultQty).length
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Filtered products
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
    // Tap to toggle
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

    get selectedProducts() {
        return this.allProducts.filter(p => p.selected);
    }

    get hasSelections()     { return this.selectedProducts.length > 0; }
    get selectedCount()     { return this.selectedProducts.length; }
    get isActionsDisabled() { return !this.hasSelections; }

    // ─────────────────────────────────────────────────────────────────────
    // CLEAR
    // ─────────────────────────────────────────────────────────────────────
    handleClear() {
        this.allProducts = this.allProducts.map(p => ({
            ...p,
            selected: false,
            rowClass: 'product-row'
        }));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SUBMIT
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        if (!this.hasSelections) return;

        const itemsToSubmit = this.selectedProducts.map(p => ({
            product2Id:        p.id,
            productName:       p.name,
            quantityRequested: (p.defaultQuantity && p.defaultQuantity > 0)
                                   ? p.defaultQuantity
                                   : 1
        }));

        if (this.isOnline) {
            await this._createPRAndLineItems(itemsToSubmit);
        } else {
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

            this.handleClear();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SYNC QUEUE
    // ─────────────────────────────────────────────────────────────────────
    async handleSyncQueue() {
        if (!this.isOnline || this.offlineQueue.length === 0) return;

        this.isSyncing = true;
        const queue    = [...this.offlineQueue];
        let   success  = 0;
        const failed   = [];

        for (const op of queue) {
            try {
                await this._createPRAndLineItems(op.items, true);
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
        let prliCount  = 0;
        let prliErrors = [];

        for (const item of items) {
            try {
                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = prId;
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = item.product2Id;
                prliFields[PRLI_STATUS.fieldApiName]        = 'Draft';
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = item.quantityRequested;

                const prliRecordInput = {
                    apiName: PRLI_OBJECT.objectApiName,
                    fields:  prliFields
                };

                console.log(`⚡ createRecord — PRLI: ${item.productName} (qty: ${item.quantityRequested})`);
                await createRecord(prliRecordInput);
                prliCount++;
                console.log('✅ PRLI created for:', item.productName);

            } catch (prliErr) {
                console.error('❌ PRLI createRecord failed for', item.productName, ':', prliErr);
                prliErrors.push(`${item.productName}: ${prliErr?.body?.message || prliErr.message}`);
            }
        }

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
            this.handleClear();
        }
    }
}
