import { LightningElement } from 'lwc';
import LightningPrompt from 'lightning/prompt';
export default class Dtvscm_productTransfer extends LightningElement {
    showInitiateTransfer =  false;

    handleTransferTo(){
        this.showInitiateTransfer = true;
    }

    handleBack(){
        this.showInitiateTransfer = false;
    }

    handleBackClick() {
    this.dispatchEvent(new CustomEvent('back'));
    }
}