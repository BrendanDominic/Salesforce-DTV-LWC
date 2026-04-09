// ── Imports ────────────────────────────────────────────────────────────────────
import { LightningElement, wire, track } from 'lwc';
import { gql, graphql, refreshGraphQL } from 'lightning/uiGraphQLApi';
import userId from '@salesforce/user/Id';

// ── Tab Constants ──────────────────────────────────────────────────────────────
const TAB_OPEN   = 'open';
const TAB_CLOSED = 'closed';

// ── Status Badge Map ───────────────────────────────────────────────────────────
const STATUS_BADGE_MAP = {
    'Draft':              'slds-badge slds-theme_info',
    'Submitted':          'slds-badge slds-theme_info',
    'Closed - Fulfilled': 'slds-badge slds-theme_success',
    'Closed - Rejected':  'slds-badge slds-theme_error',
};
const DEFAULT_BADGE_CLASS = 'slds-badge';

// ── GraphQL Query 1: Service Resource ─────────────────────────────────────────
// Finds the Service Resource record linked to the logged-in user.
const GET_SERVICE_RESOURCE = gql`
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
                        }
                    }
                }
            }
        }
    }
`;

// ── GraphQL Query 2: Open Product Requests ────────────────────────────────────
// Fetches Draft and Submitted Product Requests for this technician.
const GET_OPEN_REQUESTS = gql`
    query GetOpenProductRequests($serviceResourceId: ID) {
        uiapi {
            query {
                ProductRequest(first:500
                    where: {
                        and: [
                            { DTVSCM_Service_Resource__c: { eq: $serviceResourceId } }
                            { Status: { in: ["Draft", "Submitted"] } }
                        ]
                    }
                    orderBy: { CreatedDate: { order: DESC } }
                ) {
                    edges {
                        node {
                            Id
                            ProductRequestNumber  { value }
                            Status                { value displayValue }
                            CreatedDate           { value }
                            DTVSCM_Submit_Date__c { value }
                            ShipmentType          { value displayValue }
                        }
                    }
                }
            }
        }
    }
`;

// ── GraphQL Query 3: Closed Product Requests ──────────────────────────────────
// Fetches Closed - Fulfilled and Closed - Rejected Product Requests.
const GET_CLOSED_REQUESTS = gql`
    query GetClosedProductRequests($serviceResourceId: ID) {
        uiapi {
            query {
                ProductRequest(first:500
                    where: {
                        and: [
                            { DTVSCM_Service_Resource__c: { eq: $serviceResourceId } }
                            { Status: { in: ["Closed - Fulfilled", "Closed - Rejected"] } }
                        ]
                    }
                    orderBy: { CreatedDate: { order: DESC } }
                ) {
                    edges {
                        node {
                            Id
                            ProductRequestNumber  { value }
                            Status                { value displayValue }
                            CreatedDate           { value }
                            DTVSCM_Submit_Date__c { value }
                            ShipmentType          { value displayValue }
                        }
                    }
                }
            }
        }
    }
`;

// ── Component ──────────────────────────────────────────────────────────────────
export default class ProductRequestTiles extends LightningElement {

    // ── State ──────────────────────────────────────────────────────────────────
    activeTab        = TAB_OPEN;
    showDetail       = false;
    selectedRecordId = null;
    selectedPRNumber = null;
    isRendered       = false; // tracks whether component has rendered at least once

    // @track — changing this triggers dependent wire queries to re-run
    @track serviceResourceId = null;

    @track openRecords   = [];
    openLoading          = true;
    openError            = false;
    openErrorMessage     = '';

    @track closedRecords = [];
    closedLoading        = true;
    closedError          = false;
    closedErrorMessage   = '';

    // ── connectedCallback ──────────────────────────────────────────────────────
    // Called once when the component is inserted into the DOM.
    // Good place to initialise state or log that the component has started.
    connectedCallback() {
        //this.handleRefresh();
        console.log('productRequestTiles — connected. userId:', userId);
    }

    // ── renderedCallback ───────────────────────────────────────────────────────
    // Called every time the component re-renders (after data loads, tab changes etc).
    // We use the isRendered flag to run one-time logic only on the first render.
    renderedCallback() {
        if (!this.isRendered) {
            this.isRendered = true;
            console.log('productRequestTiles — first render complete.');
        }
    }

    // ── disconnectedCallback ───────────────────────────────────────────────────
    // Called when the component is removed from the DOM.
    // Good place to clean up any listeners or timers.
    disconnectedCallback() {
        console.log('productRequestTiles — disconnected.');
    }

    // ── Wire 1: Service Resource ───────────────────────────────────────────────
    // Runs automatically on load. Once the SR Id is set, wires 2 and 3 fire.
    @wire(graphql, {
        query: GET_SERVICE_RESOURCE,
        variables: '$srVariables'
    })
    wiredServiceResource(result) {
        this._wiredServiceResourceResult = result;
        const { data, errors } = result;
        if (errors && errors.length) {
            this._setError(errors.map(e => e.message).join('; '));
            //this.isRefreshing = false;
            return;
        }
        if (data) {
            const edges = data?.uiapi?.query?.ServiceResource?.edges || [];
            if (edges.length > 0) {
                this.serviceResourceId = edges[0].node.Id;
            } else {
                this._setError('No Service Resource found for the current user.');
            }
        }
    }

    // ── Wire 2: Open Requests ──────────────────────────────────────────────────
    // Runs automatically once serviceResourceId is set.
    @wire(graphql, {
        query: GET_OPEN_REQUESTS,
        variables: '$openQueryVariables'
    })
    wiredOpenRequests(result) {
        this._wiredOpenRequestsResult = result;
        const { data, errors } = result;
        this.openLoading = false;
        if (errors && errors.length) {
            this.openError        = true;
            this.openErrorMessage = errors.map(e => e.message).join('; ');
            //this.isRefreshing     = false;
            return;
        }
        if (data) {
            const edges = data?.uiapi?.query?.ProductRequest?.edges || [];
            this.openRecords  = edges.map(({ node }) => this._mapNode(node));
            //this.isRefreshing = false;
        }
    }


    // ── Wire 3: Closed Requests ────────────────────────────────────────────────
    // Runs automatically once serviceResourceId is set.
    @wire(graphql, {
        query: GET_CLOSED_REQUESTS,
        variables: '$closedQueryVariables'
    })
    wiredClosedRequests(result) {
        this._wiredClosedRequestsResult = result;
        const { data, errors } = result;
        this.closedLoading = false;
        if (errors && errors.length) {
            this.closedError        = true;
            this.closedErrorMessage = errors.map(e => e.message).join('; ');
            //this.isRefreshing       = false;
            return;
        }
        if (data) {
            const edges = data?.uiapi?.query?.ProductRequest?.edges || [];
            this.closedRecords = edges.map(({ node }) => this._mapNode(node));
            //this.isRefreshing  = false;
        }
    }


    // ── Wire Variables ─────────────────────────────────────────────────────────
    get srVariables() {
        return { userId: userId };
    }
    get openQueryVariables() {
        return this.serviceResourceId ? { serviceResourceId: this.serviceResourceId } : null;
    }
    get closedQueryVariables() {
        return this.serviceResourceId ? { serviceResourceId: this.serviceResourceId } : null;
    }

    // ─── REFRESH ──────────────────────────────────────────────────────────────
    async _silentRefresh(){
        try{
            if(this._wiredOpenRequestsResult){
                await refreshGraphQL(this._wiredOpenRequestsResult);
            }
            if(this._wiredClosedRequestsResult){
                await refreshGraphQL(this._wiredClosedRequestsResult);
            }
        }catch(error){
            console.error('Error refreshing:' , error);
        }
    }

    async handleRefresh() {
        try {
            this.isRefreshing  = true;
            await Promise.all([
                refreshGraphQL(this._wiredServiceResourceResult),
                this._wiredOpenRequestsResult ? refreshGraphQL(this._wiredOpenRequestsResult) : Promise.resolve(),
                this._wiredClosedRequestsResult ? refreshGraphQL(this._wiredClosedRequestsResult) : Promise.resolve(),
            ]);

        } catch (error) {
            console.error('Error refreshing data:', error);
        }finally{
            this.isRefreshing = false;
        }
    }

    // ── Computed Getters ───────────────────────────────────────────────────────
    get isOpenTab()     { return this.activeTab === TAB_OPEN; }
    get openTabClass()  { return this.activeTab === TAB_OPEN   ? 'tab-btn tab-btn--active' : 'tab-btn'; }
    get closedTabClass(){ return this.activeTab === TAB_CLOSED ? 'tab-btn tab-btn--active' : 'tab-btn'; }

    get openTabLabel() {
        return this.openRecords.length > 0 ? `Open (${this.openRecords.length})` : 'Open';
    }
    get closedTabLabel() {
        return this.closedRecords.length > 0 ? `Closed (${this.closedRecords.length})` : 'Closed';
    }

    get records()      { return this.isOpenTab ? this.openRecords      : this.closedRecords;      }
    get isLoading()    { return this.isOpenTab ? this.openLoading      : this.closedLoading;      }
    get hasError()     { return this.isOpenTab ? this.openError        : this.closedError;        }
    get errorMessage() { return this.isOpenTab ? this.openErrorMessage : this.closedErrorMessage; }
    get isEmpty()      { return !this.isLoading && !this.hasError && this.records.length === 0;   }

    // ── Handlers ──────────────────────────────────────────────────────────────
    // Fires a back event to the parent home component.
    handleHomeBack() {
        this.dispatchEvent(new CustomEvent('back'));
    }

    // Switches between Open and Closed tabs.
    handleTabClick(event) {
        const newTab = event.currentTarget.dataset.tab;
        if (this.activeTab === newTab) return;
        this.activeTab = newTab;
        this._silentRefresh();
        
    }

    // Opens the line items detail screen for the clicked tile.
    handleTileClick(event) {
        const recordId = event.currentTarget.dataset.id;
        const prNumber = event.currentTarget.dataset.number;
        if (!recordId) return;
        this.selectedRecordId = recordId;
        this.selectedPRNumber = prNumber;
        this.showDetail       = true;
    }

    // Returns from the line items detail screen back to the tile list.
    handleBack() {
        this.showDetail       = false;
        this.selectedRecordId = null;
        this.selectedPRNumber = null;
    }

    // ── Private Helpers ────────────────────────────────────────────────────────
    _setError(msg) {
        this.openError          = true;
        this.closedError        = true;
        this.openErrorMessage   = msg;
        this.closedErrorMessage = msg;
        this.openLoading        = false;
        this.closedLoading      = false;
    }

    _mapNode(node) {
        const status = node.Status?.value || '';
        return {
            Id:                     node.Id,
            ProductRequestNumber:   node.ProductRequestNumber?.value || '—',
            Status:                 node.Status?.displayValue || status,
            StatusValue:            status,
            CreatedDate:            node.CreatedDate?.value || null,
            DTVSCM_Submit_Date__c:  node.DTVSCM_Submit_Date__c?.value || null,
            ShipmentType:           node.ShipmentType?.displayValue || node.ShipmentType?.value || '—',
            statusBadgeClass:       STATUS_BADGE_MAP[status] || DEFAULT_BADGE_CLASS,
        };
    }
    
}