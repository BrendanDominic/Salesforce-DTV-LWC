import { LightningElement, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';


import { gql, graphql } from 'lightning/uiGraphQLApi';
import { createRecord } from 'lightning/uiRecordApi';
import USER_ID from '@salesforce/user/Id';


// ProductRequest schema tokens
import PR_OBJECT      from '@salesforce/schema/ProductRequest';
import PR_STATUS      from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION from '@salesforce/schema/ProductRequest.Description';


// ProductRequestLineItem schema tokens
import PRLI_OBJECT        from '@salesforce/schema/ProductRequestLineItem';
import PRLI_PR_ID         from '@salesforce/schema/ProductRequestLineItem.ParentId'; // ✅ NOT ParentId
import PRLI_PRODUCT2_ID   from '@salesforce/schema/ProductRequestLineItem.Product2Id';
import PRLI_QTY_REQUESTED from '@salesforce/schema/ProductRequestLineItem.QuantityRequested';
import PRLI_STATUS        from '@salesforce/schema/ProductRequestLineItem.Status';


// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY — fetch DTVSCM_ResourceProduct__c directly
//
// Object:  DTVSCM_ResourceProduct__c  (custom object from your screenshot)
// Fields:
//   DTVSCM_Default_Quantity__c  → Number(18,0) → maps to PRLI.QuantityRequested
//   DTVSCM_Product__c           → Lookup(Product2) → DTVSCM_Product__r gives Product2 fields
//   DTVSCM_ServiceResource__c   → Master-Detail(Service Resource) — not needed here
//   Name                        → Text(80) — ResourceProduct record name
//
// Relationship traversal:
//   DTVSCM_Product__c is a Lookup to Product2
//   In GraphQL: use DTVSCM_Product__r { Id, Name { value }, ProductCode { value } }
// ─────────────────────────────────────────────────────────────────────────────
const GET_CONTEXT_QUERY = gql`
    query GetContext($userId: ID!, $srFirst: Int!, $rpFirst: Int!) {
        uiapi {
            query {
                # 1) Resolve the ServiceResource for the running user
                ServiceResource(
                    where: { RelatedRecordId: { eq: $userId } }
                    first: $srFirst
                ) {
                    edges {
                        node { Id Name { value } }
                    }
                }

                # 2) Fetch all Resource Products (unfiltered at server), we'll filter client-side by SR
                DTVSCM_Resource_Product__c(
                    orderBy: { Name: { order: ASC } }
                    first: $rpFirst
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
                                ProductCode { value }
                            }
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


    get isScheduledTab()   { return this.activeTab === 'scheduled';   }
    get isUnscheduledTab() { return this.activeTab === 'unscheduled'; }
    get scheduledTabClass()   { return this.activeTab === 'scheduled'   ? 'tab-btn active' : 'tab-btn'; }
    get unscheduledTabClass() { return this.activeTab === 'unscheduled' ? 'tab-btn active' : 'tab-btn'; }


    handleTabSwitch(event) { this.activeTab = event.currentTarget.dataset.tab; }


    // ── Back ──────────────────────────────────────────────────────────────
    handleBack() { this.dispatchEvent(new CustomEvent('back')); }


    // ── Search ────────────────────────────────────────────────────────────
    @track searchTerm = '';
    handleSearch(event)  { this.searchTerm = event.target.value; }
    handleClearSearch()  { this.searchTerm = ''; }


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
    // GraphQL @wire — DTVSCM_ResourceProduct__c
    //
    // Mapping per node:
    //   id              = ResourceProduct.Id              (row key for for:each)
    //   product2Id      = DTVSCM_Product__r.Id            → PRLI.Product2Id
    //   name            = DTVSCM_Product__r.Name.value    → display
    //   productCode     = DTVSCM_Product__r.ProductCode   → display
    //   defaultQuantity = DTVSCM_Default_Quantity__c.value → PRLI.QuantityRequested
    // ─────────────────────────────────────────────────────────────────────
    @track allProducts      = [];
    @track isLoading        = true;
    @track hasWireError     = false;
    @track wireErrorMessage = '';

    // store resolved ServiceResource Id (for debugging/telemetry)
    @track serviceResourceId;


    // GraphQL wire with variables (running user → ServiceResource → scoped Resource Products)
    @wire(graphql, {
        query: GET_CONTEXT_QUERY,
        variables: {
            userId: USER_ID,
            srFirst: 1,
            rpFirst: 200
        }
    })
    wiredResourceProducts({ data, errors }) {


        if (data === undefined && errors === undefined) {
            this.isLoading = true;
            return;
        }


        this.isLoading = false;


        if (errors) {
            console.error('❌ GraphQL error:', JSON.stringify(errors));
            this.hasWireError     = true;
            this.wireErrorMessage = errors.map(e => e.message).join(', ');
            return;
        }


        if (data) {
            // 1) Extract ServiceResource Id from first edge (running user should map to 1 SR)
            const srEdges = data?.uiapi?.query?.ServiceResource?.edges || [];
            const srId = srEdges.length > 0 ? srEdges[0]?.node?.Id : null;
            this.serviceResourceId = srId;

            // 2) Client-side filter Resource Products by resolved ServiceResource Id
            const rpEdgesAll = data?.uiapi?.query?.DTVSCM_Resource_Product__c?.edges || [];
            const rpEdges = srId
                ? rpEdgesAll.filter(e => e?.node?.DTVSCM_ServiceResource__c?.value === srId)
                : [];

            if (!srId) {
                console.warn('⚠️ No ServiceResource resolved for the running user.');
            }
            if (rpEdges.length === 0) {
                console.warn('⚠️ No Resource Products found for current Service Resource.');
                this.allProducts = [];
                return;
            }

            this.hasWireError = false;
            console.log(`✅ ServiceResource: ${srId || 'N/A'} — RP count (filtered): ${rpEdges.length}`);

            this.allProducts = rpEdges.map(edge => {
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
                    productCode:     product2?.ProductCode?.value || '—',
                    defaultQuantity: defaultQuantity,
                    selected:        false,
                    rowClass:        'product-row'
                };
            });
        }
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
    handleProductToggle(event) {
        const productId = event.currentTarget.dataset.productid;
        this.allProducts = this.allProducts.map(p => {
            if (p.id !== productId) return p;
            const nowSelected = !p.selected;
            return { ...p, selected: nowSelected, rowClass: nowSelected ? 'product-row selected' : 'product-row' };
        });
    }


    get selectedProducts()  { return this.allProducts.filter(p => p.selected); }
    get hasSelections()     { return this.selectedProducts.length > 0; }
    get selectedCount()     { return this.selectedProducts.length; }
    get isActionsDisabled() { return !this.hasSelections; }


    // ── Clear ─────────────────────────────────────────────────────────────
    handleClear() {
        this.allProducts = this.allProducts.map(p => ({
            ...p, selected: false, rowClass: 'product-row'
        }));
    }


    // ─────────────────────────────────────────────────────────────────────
    // SUBMIT
    // Snapshot: product2Id + defaultQuantity (from DTVSCM_Default_Quantity__c)
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        if (!this.hasSelections) return;


        const itemsToSubmit = this.selectedProducts.map(p => ({
            product2Id:      p.product2Id,      // DTVSCM_Product__r.Id
            productName:     p.name,
            defaultQuantity: p.defaultQuantity  // DTVSCM_Default_Quantity__c value
        }));


        if (this.isOnline) {
            await this._createPRAndLineItems(itemsToSubmit);
        } else {
            this.offlineQueue = [
                ...this.offlineQueue,
                { id: Date.now(), items: itemsToSubmit, timestamp: new Date().toISOString() }
            ];
            this.dispatchEvent(new ShowToastEvent({
                title: 'Queued Offline',
                message: `${itemsToSubmit.length} item(s) queued. Will sync when online.`,
                variant: 'warning'
            }));
            this.handleClear();
        }
    }


    // ── Sync queue ────────────────────────────────────────────────────────
    async handleSyncQueue() {
        if (!this.isOnline || this.offlineQueue.length === 0) return;
        this.isSyncing = true;
        const queue = [...this.offlineQueue];
        let success = 0;
        const failed = [];


        for (const op of queue) {
            try {
                await this._createPRAndLineItems(op.items, true);
                this.offlineQueue = this.offlineQueue.filter(q => q.id !== op.id);
                success++;
            } catch (err) {
                console.error('❌ Sync failed:', err);
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


    // ─────────────────────────────────────────────────────────────────────
    // PRIVATE — _createPRAndLineItems
    //
    // STEP 1: createRecord(ProductRequest)
    // STEP 2: per selected item → createRecord(ProductRequestLineItem)
    //   Product2Id        ← item.product2Id      (DTVSCM_Product__r.Id)
    //   QuantityRequested ← item.defaultQuantity  (DTVSCM_Default_Quantity__c)
    // ─────────────────────────────────────────────────────────────────────
    async _createPRAndLineItems(items, silent = false) {


        // STEP 1 — ProductRequest
        const prFields = {};
        prFields[PR_STATUS.fieldApiName]      = 'Draft';
        prFields[PR_DESCRIPTION.fieldApiName] = `Product Request — ${items.length} item(s) — ${new Date().toLocaleDateString()}`;


        console.log('⚡ Creating ProductRequest...');
        const prResult = await createRecord({ apiName: PR_OBJECT.objectApiName, fields: prFields });
        const prId     = prResult.id;
        console.log('✅ ProductRequest created:', prId);


        // STEP 2 — ProductRequestLineItem per selected product
        let prliCount  = 0;
        const prliErrors = [];


        for (const item of items) {
            try {
                if (!item.product2Id) {
                    throw new Error(`No Product2Id found — check DTVSCM_Product__r is populated on ResourceProduct: ${item.productName}`);
                }


                const prliFields = {};
                prliFields[PRLI_PR_ID.fieldApiName]         = prId;               // ProductRequestId ✅
                prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = item.product2Id;    // from DTVSCM_Product__r.Id
                prliFields[PRLI_STATUS.fieldApiName]        = 'Draft';
                prliFields[PRLI_QTY_REQUESTED.fieldApiName] = item.defaultQuantity; // from DTVSCM_Default_Quantity__c ✅


                console.log(`⚡ PRLI — ${item.productName} | Product2Id: ${item.product2Id} | Qty: ${item.defaultQuantity}`);
                await createRecord({ apiName: PRLI_OBJECT.objectApiName, fields: prliFields });
                prliCount++;
                console.log(`✅ PRLI created for: ${item.productName} qty=${item.defaultQuantity}`);


            } catch (prliErr) {
                console.error('❌ PRLI failed:', item.productName, prliErr);
                prliErrors.push(`${item.productName}: ${prliErr?.body?.message || prliErr.message}`);
            }
        }


        if (prliErrors.length > 0) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Some Line Items Failed',
                message: prliErrors.join(' | '),
                variant: 'error', mode: 'sticky'
            }));
        }


        console.log(`✅ Done — PR ${prId} with ${prliCount} line item(s)`);


        if (!silent) {
            this.dispatchEvent(new ShowToastEvent({
                title: '✅ Request Submitted!',
                message: `Product Request created with ${prliCount} line item(s).`,
                variant: 'success'
            }));
            this.handleClear();
        }
    }
}