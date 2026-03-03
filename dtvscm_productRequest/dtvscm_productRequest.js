import { LightningElement, track, wire } from 'lwc';
import { gql, graphql } from 'lightning/uiGraphQLApi';

const SCHEDULED_COLUMNS = [
    { label: 'Product Name', fieldName: 'productName' },
    { label: 'Quantity', fieldName: 'quantity', type: 'number' }
];
const UNSCHEDULED_COLUMNS = [
    { label: 'Product Name', fieldName: 'productName' },
    { label: 'Quantity', fieldName: 'quantity', type: 'number', editable: true }
];
const ALLOCATION_QUERY = gql`
            query ScheduledProducts {
                uiapi {
                    query {
                        DTVSCM_ResourceProductAllocation__c {
                            edges {
                                node {
                                    Id
                                    Product__r { 
                                        Name { value } 
                                    }
                                    Default_Quantity__c { value }
                                }
                            }
                        }
                    }
                }
            }
        `;

export default class Dtvscm_productRequest extends LightningElement {
    @track isScheduled = true;
    @track isUnscheduled = false;
    @track isLoading = false;

    // Control variables to trigger GraphQL wires
    fetchUnscheduled = false;

    // Scheduled tab state
    @track scheduledProducts = [];
    @track scheduledSelectedRows = [];
    scheduledColumns = SCHEDULED_COLUMNS;
    @track selectedRowsCount = 0;
 
    // Unscheduled tab state 
    @track unscheduledRequestType;
    @track unscheduledDateNeededBy;
    @track showUnscheduledProductSelection = false;
    @track unscheduledProducts = [];
    @track unscheduledDraftValues = [];
    unscheduledColumns = UNSCHEDULED_COLUMNS;

    // 1. GraphQL Wire for Scheduled Products
    @wire(graphql, {
        query: ALLOCATION_QUERY
    })
    wiredScheduled({ data, errors }) {
        this.isLoading = true;
        if (data) {
            const edges = data.uiapi.query.DTVSCM_ResourceProductAllocation__c.edges;
            this.scheduledProducts = edges.map(edge => ({
                id: edge.node.Id,
                productName: edge.node.Product__r?.Name?.value,
                quantity: edge.node.Default_Quantity__c?.value
            }));
            this.isLoading = false;
        } else if (errors) {
            console.error('Scheduled Error:', errors);
            this.isLoading = false;
        }
    }


    // 2. GraphQL Wire for All Products (triggered by fetchUnscheduled)
    @wire(graphql, {
        query: gql`
            query AllProducts {
                uiapi {
                    query {
                        Product2 {
                            edges {
                                node {
                                    Id
                                    Name { value }
                                }
                            }
                        }
                    }
                }
            }
        `,
        // This makes the wire reactive; it only executes when fetchUnscheduled is true
        variables: '$fetchVariables' 
    })
    wiredUnscheduled({ data, errors }) {
        if (data && this.fetchUnscheduled) {
            const edges = data.uiapi.query.Product2.edges;
            this.unscheduledProducts = edges.map(edge => ({
                id: edge.node.Id,
                productName: edge.node.Name?.value,
                quantity: 1
            }));
            this.isLoading = false;
            this.showUnscheduledProductSelection = true;
        } else if (errors) {
            console.error('Unscheduled Error:', errors);
            this.isLoading = false;
        }
    }

    // Computed property for wire reactivity
    get fetchVariables() {
        return this.fetchUnscheduled ? { dummy: 'trigger' } : {};
    }

    // Tab Logic
    get scheduledTabClass() { return this.isScheduled ? 'tab-btn active' : 'tab-btn'; }
    get unscheduledTabClass() { return this.isUnscheduled ? 'tab-btn active' : 'tab-btn'; }

    showScheduledTab() {
        this.isScheduled = true;
        this.isUnscheduled = false;
    }

    showUnscheduledTab() {
        this.isScheduled = false;
        this.isUnscheduled = true;
    }

    // Actions
    handleScheduledRowSelection(event){
        console.log('Event Fired', event.detail.scheduledSelectedRows);
        //this.selectedRows = event.detail.scheduledSelectedRows;
        //this.selectedRowsCount = this.selectedRows.length;
        //console.log('Selected Rows:', this.selectedRows);
    }

    handleUnscheduledNext() {
        this.isLoading = true;
        this.fetchUnscheduled = true; // This triggers the second @wire
    }

    handleUnscheduledCellChange(event) {
        const { draftValues } = event.detail;
        // Apply draft changes to local array
        draftValues.forEach(draft => {
            const index = this.unscheduledProducts.findIndex(p => p.id === draft.id);
            if (index > -1) {
                this.unscheduledProducts[index] = { ...this.unscheduledProducts[index], ...draft };
                //console.log('logss >>>' ,this.unscheduledProducts );
            }
        });
    }

    handleScheduledClear() { this.scheduledSelectedRows = []; }
    handleUnscheduledClear() {
        this.unscheduledRequestType = null;
        this.unscheduledDateNeededBy = null;
        this.showUnscheduledProductSelection = false;
        this.fetchUnscheduled = false;
    }

    handleBackClick() {
    this.dispatchEvent(new CustomEvent('back'));
    }
}