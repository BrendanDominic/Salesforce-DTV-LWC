/**
 * DtvscmProductRequestController
 *
 * Apex controller for the dtvscm_productRequest LWC.
 *
 * PURPOSE — Custom Metadata via Apex instead of GraphQL/UI API:
 *   Salesforce UI API (GraphQL wire adapter) does NOT support Custom Metadata
 *   records in offline priming/caching. This means the LWC could not load
 *   status configuration values when the device was offline.
 *
 *   @AuraEnabled(cacheable=true) methods ARE included in offline priming,
 *   so moving the Custom Metadata fetch here makes the configuration
 *   available offline without any change to component behaviour.
 *
 * RETRIEVAL APPROACH — Custom Metadata static methods (not SOQL):
 *   Salesforce exposes DTVSCM_Configuration__mdt.getInstance(developerName)
 *   as a built-in static method that reads from the application cache.
 *   Using it instead of SOQL aligns with the recommended Salesforce pattern
 *   for Custom Metadata access and avoids an unnecessary SOQL query.
 *
 * USAGE:
 *   @wire(getPrConfig) in dtvscm_productRequest.js
 */
public with sharing class DtvscmProductRequestController {

    /**
     * PrConfigResult — inner wrapper returned to LWC.
     *
     * Field names match the existing this.config keys in the LWC exactly:
     *   defaultStatus, submitStatus, closedRejectedStatus, closedFulfilledStatus
     *
     * The LWC maps these fields directly to this.config — no LWC logic changed.
     */
    public class PrConfigResult {
        @AuraEnabled public String defaultStatus         { get; set; }
        @AuraEnabled public String submitStatus          { get; set; }
        @AuraEnabled public String closedRejectedStatus  { get; set; }
        @AuraEnabled public String closedFulfilledStatus { get; set; }
    }

    /**
     * getPrConfig — returns the four PR status values from Custom Metadata.
     *
     * Reads via DTVSCM_Configuration__mdt.getInstance(developerName) — the
     * built-in static method that reads from the Apex application cache.
     * No SOQL query is issued; this follows the Salesforce-recommended pattern
     * for Custom Metadata retrieval.
     *
     * @AuraEnabled(cacheable=true) ensures:
     *  1. The result is cached on the client (no repeated Apex calls).
     *  2. The response is included in offline priming so it is available
     *     when the device is offline.
     *  3. Wire adapter compatibility in LWC (@wire(getPrConfig)).
     *
     * Records read (DeveloperName → PrConfigResult field):
     *   Default_PR_Status          → defaultStatus
     *   Submit_PR_Status           → submitStatus
     *   Closed_Rejected_PR_Status  → closedRejectedStatus
     *   Closed_Fulfilled_PR_Status → closedFulfilledStatus
     *
     * @return PrConfigResult wrapper with all four status values.
     * @throws AuraHandledException if any required metadata record is missing.
     */
    @AuraEnabled(cacheable=true)
    public static PrConfigResult getPrConfig() {
        // Read each record via getInstance() — the built-in static method that
        // reads DTVSCM_Configuration__mdt from the Apex application cache.
        // No SOQL query is issued; this is the Salesforce-recommended approach
        // for Custom Metadata access (SOQL is only needed when all field data
        // beyond 255 chars is required, which is not the case here).
        DTVSCM_Configuration__mdt recDefault  = DTVSCM_Configuration__mdt.getInstance('Default_PR_Status');
        DTVSCM_Configuration__mdt recSubmit   = DTVSCM_Configuration__mdt.getInstance('Submit_PR_Status');
        DTVSCM_Configuration__mdt recRejected = DTVSCM_Configuration__mdt.getInstance('Closed_Rejected_PR_Status');
        DTVSCM_Configuration__mdt recFulfill  = DTVSCM_Configuration__mdt.getInstance('Closed_Fulfilled_PR_Status');

        // Extract values — getInstance() returns null if the record does not exist.
        String defaultVal   = recDefault  != null ? recDefault.Value__c  : null;
        String submitVal    = recSubmit   != null ? recSubmit.Value__c   : null;
        String rejectedVal  = recRejected != null ? recRejected.Value__c : null;
        String fulfillVal   = recFulfill  != null ? recFulfill.Value__c  : null;

        // Validate that all required records are present and have non-blank values.
        // Same guard as before — throws AuraHandledException listing missing keys.
        List<String> missing = new List<String>();
        if (String.isBlank(defaultVal))  missing.add('Default_PR_Status');
        if (String.isBlank(submitVal))   missing.add('Submit_PR_Status');
        if (String.isBlank(rejectedVal)) missing.add('Closed_Rejected_PR_Status');
        if (String.isBlank(fulfillVal))  missing.add('Closed_Fulfilled_PR_Status');

        if (!missing.isEmpty()) {
            throw new AuraHandledException(
                'Product Request Status metadata is not properly configured. Missing: ' +
                String.join(missing, ', ')
            );
        }

        // Map to the PrConfigResult wrapper — field names match this.config in the LWC.
        PrConfigResult result        = new PrConfigResult();
        result.defaultStatus         = defaultVal;
        result.submitStatus          = submitVal;
        result.closedRejectedStatus  = rejectedVal;
        result.closedFulfilledStatus = fulfillVal;

        return result;
    }
}
