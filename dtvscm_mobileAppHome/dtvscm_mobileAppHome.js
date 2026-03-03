import { LightningElement } from 'lwc';
export default class Dtvscm_mobileAppHome extends LightningElement {
    showProductRequest = false;
    showRequestStatus = false;
    showProductTransfer = false;
    showIncomingTransfer = false;

    get isAllFlagsFalse() {
        return !this.showProductRequest && !this.showRequestStatus && 
                !this.showProductTransfer && !this.showIncomingTransfer;
    }

    handleProductRequest() {
        this.showProductRequest = true;
        this.showRequestStatus = false;
        this.showProductTransfer = false;
        this.showIncomingTransfer = false;
    }

    handleRequestStatus() {
        this.showProductRequest = false;
        this.showRequestStatus = true;
        this.showProductTransfer = false;
        this.showIncomingTransfer = false;
    }

    handleProductTransfer() {
        this.showProductRequest = false;
        this.showRequestStatus = false;
        this.showProductTransfer = true;
        this.showIncomingTransfer = false;
    }

    handleIncomingTransfer() {
        this.showProductRequest = false;
        this.showRequestStatus = false;
        this.showProductTransfer = false;
        this.showIncomingTransfer = true;
    }

    handleBack() {
        this.showProductTransfer = false;
        this.showProductRequest = false;
    }
}