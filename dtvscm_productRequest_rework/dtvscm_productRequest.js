import { LightningElement, wire, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import FORM_FACTOR from '@salesforce/client/formFactor';

import { gql, graphql } from 'lightning/uiGraphQLApi';
import { createRecord, updateRecord, deleteRecord } from 'lightning/uiRecordApi';
import USER_ID from '@salesforce/user/Id';

// ProductRequest schema tokens
import PR_OBJECT      from '@salesforce/schema/ProductRequest';
import PR_STATUS      from '@salesforce/schema/ProductRequest.Status';
import PR_DESCRIPTION from '@salesforce/schema/ProductRequest.Description';
import PR_ID          from '@salesforce/schema/ProductRequest.Id';

// ProductRequestLineItem schema tokens
import PRLI_OBJECT        from '@salesforce/schema/ProductRequestLineItem';
import PRLI_PR_ID         from '@salesforce/schema/ProductRequestLineItem.ParentId';
import PRLI_PRODUCT2_ID   from '@salesforce/schema/ProductRequestLineItem.Product2Id';
import PRLI_QTY_REQUESTED from '@salesforce/schema/ProductRequestLineItem.QuantityRequested';
import PRLI_STATUS        from '@salesforce/schema/ProductRequestLineItem.Status';

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

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL QUERY 2 — Draft ProductRequest for running user
// ─────────────────────────────────────────────────────────────────────────────
const GET_DRAFT_PR_QUERY = gql`
    query GetDraftPR($userId: ID) {
        uiapi {
            query {
                ProductRequest(
                    where: { CreatedById: { eq: $userId }, Status: { eq: "Draft" } }
                    orderBy: { CreatedDate: { order: DESC } }
                    first: 1
                ) {
                    edges {
                        node {
                            Id
                            Status { value }
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

    handleTabSwitch(event) { this.activeTab = event.currentTarget.dataset.tab; }

    // ── Back ──────────────────────────────────────────────────────────────
    handleBack() { this.dispatchEvent(new CustomEvent('back')); }

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
    @track activePrStatus    = 'Draft';
    @track isLoading         = true;
    @track hasWireError      = false;
    @track wireErrorMessage  = '';
    @track serviceResourceId = null;

    // Internal flags to track which wires have resolved
    _srLoaded  = false;
    _prLoaded  = false;
    _rpLoaded  = false;

    // Raw edges stored so we can rebuild product list after SR resolves
    _rpEdgesAll = [];

    // PRLI map: Product2Id → PRLI Record Id
    @track prliMap   = new Map();
    @track prliLoaded = false;

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
        return { userId: USER_ID };
    }

    @wire(graphql, { query: GET_DRAFT_PR_QUERY, variables: '$draftPrVariables' })
    wiredDraftPR({ data, errors }) {
        if (data === undefined && errors === undefined) return;

        this._prLoaded = true;

        if (errors) {
            console.error('❌ Draft PR wire error:', JSON.stringify(errors));
            this.activePrId     = null;
            this.activePrStatus = 'Draft';
            this._tryFinishLoading();
            return;
        }

        if (data) {
            const edges = data?.uiapi?.query?.ProductRequest?.edges || [];
            const existingPr = edges.length > 0 ? edges[0]?.node : null;

            if (existingPr) {
                this.activePrId     = existingPr.Id;
                this.activePrStatus = existingPr?.Status?.value || 'Draft';
                console.log('✅ Existing Draft PR found:', this.activePrId);
            } else {
                this.activePrId     = null;
                this.activePrStatus = 'Draft';
                console.log('ℹ️ No existing Draft PR for user.');
            }
            this._tryFinishLoading();
        }
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
    wiredPrli({ data, errors }) {
        if (data === undefined && errors === undefined) return;

        if (errors) {
            console.error('❌ PRLI wire error:', JSON.stringify(errors));
            this.prliLoaded = true;
            return;
        }

        if (data) {
            const edges = data?.uiapi?.query?.ProductRequestLineItem?.edges || [];
            const map = new Map();

            for (const e of edges) {
                const p2id = e?.node?.Product2Id?.value;
                const rid  = e?.node?.Id;
                if (p2id && rid) {
                    map.set(p2id, rid);
                }
            }

            this.prliMap    = map;
            this.prliLoaded = true;
            console.log('✅ PRLI map loaded:', map.size, 'entries');

            // Apply saved selections to UI
            this._applySelectionsFromPrliMap();
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
            return;
        }

        // Filter by ServiceResource
        const rpEdges = this._rpEdgesAll.filter(e =>
            e?.node?.DTVSCM_ServiceResource__c?.value === this.serviceResourceId
        );

        if (rpEdges.length === 0) {
            console.warn('⚠️ No Resource Products for this ServiceResource');
            this.allProducts = [];
            return;
        }

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
                description:     product2?.Description?.value || '—',
                productCode:     product2?.ProductCode?.value || '—',
                defaultQuantity: defaultQuantity,
                selected:        false,
                rowClass:        'product-row'
            };
        });

        console.log('✅ Products built:', this.allProducts.length);

        // If PRLIs already loaded, apply saved selections
        if (this.prliLoaded && this.activePrId) {
            this._applySelectionsFromPrliMap();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Turn off loading spinner once all 3 main wires have resolved
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
        if (this.allProducts.length === 0 || this.prliMap.size === 0) return;

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
    get isSubmitted()       { return this.activePrStatus === 'Submitted'; }

    // ── Clear ─────────────────────────────────────────────────────────────
    handleClear() {
        this.allProducts = this.allProducts.map(p => ({
            ...p, selected: false, rowClass: 'product-row'
        }));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SAVE — ensure PR exists, then delta-sync PRLIs to match UI
    //
    // Step 1: If no activePrId → createRecord(ProductRequest)
    // Step 2: Compare UI selections vs prliMap (server truth)
    // Step 3: Create missing PRLIs, delete removed PRLIs
    // ─────────────────────────────────────────────────────────────────────
    @track isSaving = false;

    async handleSave() {
        if (this.isSubmitted) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Request Submitted',
                message: 'This Product Request is submitted and can no longer be edited.',
                variant: 'info'
            }));
            return;
        }

        this.isSaving = true;

        try {
            // ── STEP 1: Ensure ProductRequest exists ──────────────────────
            if (!this.activePrId) {
                const prFields = {};
                prFields[PR_STATUS.fieldApiName]      = 'Draft';
                prFields[PR_DESCRIPTION.fieldApiName] = `Product Request — ${new Date().toLocaleDateString()}`;

                console.log('⚡ Creating ProductRequest...');
                const prResult = await createRecord({
                    apiName: PR_OBJECT.objectApiName,
                    fields: prFields
                });
                this.activePrId     = prResult.id;
                this.activePrStatus = 'Draft';
                console.log('✅ ProductRequest created:', this.activePrId);
            }

            // ── STEP 2: Compute delta between UI and server ───────────────
            const existingMap = this.prliMap;          // Map(Product2Id → PRLI.Id)
            const existingIds = new Set(existingMap.keys());

            const selected    = this.selectedProducts;
            const selectedP2Ids = new Set(selected.map(p => p.product2Id).filter(Boolean));

            // Products selected in UI but NOT yet on server → need createRecord
            const toCreate = [...selectedP2Ids].filter(pid => !existingIds.has(pid));
            // Products on server but NOT selected in UI → need deleteRecord
            const toDelete = [...existingIds].filter(pid => !selectedP2Ids.has(pid));

            console.log(`📊 Save delta — Create: ${toCreate.length}, Delete: ${toDelete.length}`);

            // ── STEP 3a: Create new PRLIs ─────────────────────────────────
            const createErrors = [];
            for (const pid of toCreate) {
                const p = selected.find(x => x.product2Id === pid);
                if (!p) continue;
                try {
                    const prliFields = {};
                    prliFields[PRLI_PR_ID.fieldApiName]         = this.activePrId;
                    prliFields[PRLI_PRODUCT2_ID.fieldApiName]   = pid;
                    prliFields[PRLI_STATUS.fieldApiName]        = 'Draft';
                    prliFields[PRLI_QTY_REQUESTED.fieldApiName] = (p.defaultQuantity && Number(p.defaultQuantity) > 0)
                        ? Number(p.defaultQuantity) : 1;

                    console.log(`⚡ Creating PRLI: ${p.name} (qty: ${p.defaultQuantity})`);
                    const prliResult = await createRecord({
                        apiName: PRLI_OBJECT.objectApiName,
                        fields: prliFields
                    });
                    console.log(`✅ PRLI created: ${p.name} → ${prliResult.id}`);

                    // Update local prliMap so next save has correct state
                    this.prliMap.set(pid, prliResult.id);

                } catch (e) {
                    console.error(`❌ PRLI create failed: ${p.name}`, e);
                    createErrors.push(`${p.name}: ${e?.body?.message || e.message}`);
                }
            }

            // ── STEP 3b: Delete removed PRLIs ─────────────────────────────
            const deleteErrors = [];
            for (const pid of toDelete) {
                try {
                    const recId = existingMap.get(pid);
                    if (recId) {
                        console.log(`🗑️ Deleting PRLI for Product2Id: ${pid} (${recId})`);
                        await deleteRecord(recId);
                        // Remove from local map
                        this.prliMap.delete(pid);
                    }
                } catch (e) {
                    console.error(`❌ PRLI delete failed: ${pid}`, e);
                    deleteErrors.push(`Delete ${pid}: ${e?.body?.message || e.message}`);
                }
            }

            // ── STEP 4: Toast ─────────────────────────────────────────────
            if (createErrors.length === 0 && deleteErrors.length === 0) {
                this.dispatchEvent(new ShowToastEvent({
                    title: '✅ Saved',
                    message: `Draft saved — ${toCreate.length} added, ${toDelete.length} removed.`,
                    variant: 'success'
                }));
            } else {
                const msg = [...createErrors, ...deleteErrors].join(' | ');
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
    // SUBMIT — save delta first, then update PR.Status = 'Submitted'
    // ─────────────────────────────────────────────────────────────────────
    async handleSubmit() {
        if (this.isSubmitted) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Already Submitted',
                message: 'This Product Request is already submitted.',
                variant: 'info'
            }));
            return;
        }

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
            fields[PR_STATUS.fieldApiName] = 'Submitted';

            console.log('⚡ Submitting PR:', this.activePrId);
            await updateRecord({ fields });
            this.activePrStatus = 'Submitted';
            console.log('✅ PR submitted');

            // Lock UI
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
        const prFields = {};
        prFields[PR_STATUS.fieldApiName]      = 'Draft';
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
                prliFields[PRLI_STATUS.fieldApiName]        = 'Draft';
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
}
