import { LightningElement, api, wire, track } from 'lwc';
import { gql, graphql, refreshGraphQL } from 'lightning/uiGraphQLApi';

const GET_LINE_ITEMS = gql`
    query GetLineItems($recordId: ID) {
        uiapi {
            query {
                ProductRequestLineItem(
                    where: { ParentId: { eq: $recordId } }
                    orderBy: { ProductRequestLineItemNumber: { order: ASC } }
                    first: 100
                ) {
                    edges {
                        node {
                            Id
                            ProductRequestLineItemNumber { value }
                            QuantityRequested            { value }
                            Product2 {
                                Name { value }
                            }
                        }
                    }
                }
            }
        }
    }
`;

export default class ProductRequestLineItems extends LightningElement {

    @api recordId;
    @api productRequestNumber;

    @track lineItems = [];
    isLoading    = true;
    hasError     = false;
    errorMessage = '';
    @track isRefreshing = false;

    _wiredLineItemsResult;

    @wire(graphql, { query: GET_LINE_ITEMS, variables: '$queryVariables' })
    wiredLineItems(value) {
        this._wiredLineItemsResult = value;
        const { data, errors } = value;
        if (data === undefined && errors === undefined) return;
        this.isLoading = false;
        if (errors?.length) {
            this.hasError     = true;
            this.errorMessage = errors.map(e => e.message).join('; ');
            return;
        }
        if (data) {
            const edges = data?.uiapi?.query?.ProductRequestLineItem?.edges || [];
            this.lineItems = edges.map(({ node }) => ({
                Id:                node.Id,
                LineItemNumber:    node.ProductRequestLineItemNumber?.value || '—',
                QuantityRequested: node.QuantityRequested?.value            || '—',
                ProductName:       node.Product2?.Name?.value               || '—'
            }));
        }
    }

    async handleRefresh() {
        if (this.isRefreshing || !this._wiredLineItemsResult) return;
        this.isRefreshing = true;
        try {
            await refreshGraphQL(this._wiredLineItemsResult);
        } catch (err) {
            console.error('Error refreshing line items:', err);
        } finally {
            this.isRefreshing = false;
        }
    }

    get queryVariables() {
        return this.recordId ? { recordId: this.recordId } : null;
    }

    get isEmpty()  { return !this.isLoading && !this.hasError && this.lineItems.length === 0; }
    get showList() { return !this.isLoading && !this.hasError && this.lineItems.length > 0;   }

    handleBack() {
        this.dispatchEvent(new CustomEvent('back'));
    }
}