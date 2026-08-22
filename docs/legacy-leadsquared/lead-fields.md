# Lead Object — Complete Field Schema (Bigul / Bonanza tenant)
Source: Settings > Leads > Lead Fields (schema-name index)
~330 fields total. System fields + `mx_` custom fields.

## SYSTEM / STANDARD FIELDS
Mobile, ConversionReferrerURL, CreatedByName, CreatedOn, CurrentOptInStatus,
DoNotCall, DoNotEmail, DoNotSMS, DoNotTrack, EmailAddress, EngagementScore,
FacebookId, FirstName, GooglePlusId, GTalkId, LastName, Latitude, LeadAge,
ProspectAutoId, Origin, QualityScore01, Score, Source, ProspectStage,
LinkedInId, Longitude, MailingPreferences, Phone, ModifiedByName, ModifiedOn,
Notes, OptInDate, OptInDetails, OwnerId, OwnerIdName, LastOptInEmailSentDate,
PhotoUrl, LeadConversionDate, Groups, SkypeId, SourceCampaign, SourceContent,
SourceIPAddress, SourceMedium, SourceReferrerURL, TimeZone, Revenue,
TwitterId, Website, JobTitle

Observations for CRM design:
- Built-in identity: FirstName/LastName/EmailAddress/Phone/Mobile
- Built-in scoring: Score, EngagementScore, QualityScore01
- Built-in consent/compliance: DoNotCall, DoNotEmail, DoNotSMS, DoNotTrack,
  CurrentOptInStatus, OptInDate, OptInDetails, MailingPreferences, LastOptInEmailSentDate
- Built-in attribution: Source, SourceCampaign, SourceMedium, SourceContent,
  SourceReferrerURL, SourceIPAddress, ConversionReferrerURL, Origin
- Built-in lifecycle: ProspectStage, LeadAge, LeadConversionDate, CreatedOn, ModifiedOn
- Built-in ownership: OwnerId/OwnerIdName, Groups
- Social handles are first-class (Facebook/LinkedIn/Twitter/GooglePlus/Skype/GTalk) — legacy-era design

## CUSTOM FIELDS (mx_ prefix) — grouped by business domain

### Identity / KYC / Account
mx_Account_Number, mx_PAN_Number, mx_PAN_Submitted_Date, mx_Client_BOID,
mx_Client_Code, mx_Client_Code_2, mx_Client_Code_3, mx_Client_Code_4,
mx_Client_Code_5, mx_Client_Code_6, mx_Submit_Client_Code, mx_Terminal_Code,
mx_DOT_Code, mx_BA_Code, mx_Branch_Code, mx_Branch_Type, mx_Branch_IFSC,
mx_Bank_Name, mx_Depository, mx_DDPI, mx_KRA_status, mx_KYC_Journey_Mode,
mx_EKYC_Plan_Detail, mx_Email_Verification, mx_Mobile_Verification,
mx_Politically_Exposed_Person, mx_Father_Name, mx_Date_of_Birth, mx_Gender,
mx_Marital_Status, mx_Occupation, mx_Job_Or_Service, mx_Fresher,
mx_Annual_Income, mx_Income, mx_Income_2, mx_Income_Category,
mx_DIY_Account_Opened, mx_LD_Account_Opened_Date, mx_LD_Client_Name,
mx_clientkycreativation (see opp), mx_First_Dropoff_Application_Status

### Address / Geography
mx_Street1, mx_Street2, mx_City, mx_State, mx_Country, mx_Zip, mx_Region,
mx_Custom_IP_Address

### Trading activity / product usage (core business telemetry)
mx_Active_Exchanges_Cash, mx_Active_Exchanges_Derivatives,
mx_Equity_active, mx_Equity_Activation_DateTime,
mx_Derivatives_active, mx_Derivatives_Activation_DateTime,
mx_FO_Equity_Active, mx_FO_Commodity_Active, mx_FO_Currency_Active,
mx_MF_active, mx_MF_Activation_DateTime, mx_MF_Activity,
mx_GI_active, mx_GI_Activation_DateTime,
mx_Segments, mx_Segment_Activation, mx_Segment_Activation_Derivative,
mx_Trade_day_activation, mx_Customer_Activated_On_Date,
mx_Customer_Active_Status, mx_Customer_Converted_On_Date,
mx_First_Traded_Date, mx_First_Traded_Date_Counter,
mx_Last_Traded_Date, mx_Last_Traded_Date_Time,
mx_Trades_Placed_Last_1_Year, mx_Trades_Placed_Yesterday,
mx_Number_Of_Trade_place, mx_View_Trade_RTT,
mx_Ready_To_Trade, mx_Ready_To_Trade_Activity_Date,
mx_LM_Traded_NT, mx_Demo_NT, mx_NTFA_Status,
mx_ISIN_COUNT, mx_HOLDING_VALUE, mx_Total_Holding_Value,
mx_Has_Any_Holding_with_Other_Broking_Firms

### Financial / revenue
mx_Brokerage_Amount, mx_Brokerage_Generated, mx_Brokerage_Last_1_Year,
mx_Brokerage_Yesterday, mx_Brokerage_Plan,
mx_Ledger_Balance, mx_Current_Margin, mx_Total_margin,
mx_How_Much_Margin_Pitched, mx_How_much_margin_pitched_2,
mx_Last_Margin_Added_Date, mx_Presales_Initial_Margin_Commitmnt,
mx_Today_Payin, mx_Payment_Payin, mx_Payment_Payout,
mx_Payment_Initiated, mx_Payment_Link, mx_Payment_Method, mx_Payment_Status,
mx_AUM_Category, mx_Collateral

### RFM / scoring / segmentation
mx_Activity_Score, mx_Intent_Score, mx_Recency_Rating, mx_Frequency_Rating,
mx_Monetary_rating, mx_Call_Quality_Score, mx_Client_Base, mx_Client_Journey,
mx_Lead_Status, mx_Lead_Type, mx_Business_Segment

### BANT / qualification
mx_Budget, mx_Authority, mx_Needs, mx_Timeline, mx_BANT_Summary,
mx_Intent, mx_First_Intent, mx_Intent_Justification, mx_Intent_Justification_2,
mx_Competitors_Mentioned, mx_Existing_Broker_Name

### Call centre / dispositions (very heavy usage)
mx_Disposition, mx_Sub_Disposition, mx_Sub_disposition_2,
mx_Contacted_Disposition, mx_AI_Disposition_Status,
mx_Phone_call_disposition_2, mx_Phone_call_subdisposition,
mx_Disposition_Notes_Remarks, mx_Telecaller_Calling_Status,
mx_First_Attempt, mx_Last_Attempts, mx_Last_Dial_Date,
mx_ConnectedAttempts, mx_Not_Connected_Attempts, mx_Total_Connects_and_Attempts,
mx_Number_of_Follow_Up, mx_Number_of_No_Response, mx_Number_of_Pitch_Done,
mx_Talk_Time_duration, mx_Talk_Time_Duration_In_Minutes,
mx_Last_Inbound_Call_Date_Time, mx_Today_called,
mx_Dealer_attempt, mx_Dealer_Calling, mx_Dealer_First_Attempt, mx_Dealer_Note,
mx_Non_Contactable_Reason, mx_Non_Contactable_Reasons,
mx_Not_Interested_Reason, mx_Disinterest_Group,
mx_Rejection_Reason, mx_Rejection_Reason_Shifting,
mx_Objection_or_Concern_Category, mx_Objection_or_Concern_Handling,
mx_Objection_or_Concerns_Raised, mx_Objection_Concern_Handling,
mx_Objection_Concern_Raised,
mx_What_time_suitable_for_call, mx_Best_time_to_discussion_opportunities_or_demo,
mx_Welcome_Call, mx_Welcome_Webinar_Attended

### Ownership / assignment / org
mx_Opportunity_Owner, mx_Cross_Sale_Team_Owner, mx_From_Owner, mx_To_Owner,
mx_RM_Name, mx_RM_Email, mx_RM_Code_New, mx1_RM_Code, mx_RM_Mobile_Number,
mx_Team_Leader, mx_Partner_RM,
mx_Partner_Business_RM_Name, mx_Partner_Business_RM_Email_ID,
mx_Partner_Business_RM_Contact_Number,
mx_Lead_Reassign_Date, mx_Latest_Sales_User_Assign_Date

### Partner / channel
mx_Partner_Code, mx_Partner_DOT_Code, mx_Partner_Journey,
mx_Partner_Registration_Date, mx_Referral_Id, mx_Referral_UTM_Link,
mx_Referrer_Name, mx_Client_Referral_UTM

### Marketing attribution (extends built-in)
mx_Campaign_ID, mx_CampaignName, mx_Campaign_Type,
mx_Agent_Source_Campaign, mx_Agent_Source_Medium,
mx_Latest_Campaign, mx_Latest_Content, mx_Latest_Medium, mx_Latest_Source,
mx_Latest_Term, mx_Source_Product, mx_Source_Term, mx_Source_URL,
mx_Path_to_Conversion, mx_Path_to_Conversion2,
mx_utm_afcam, mx_utm_afid, mx_utm_afms, mx_af_adset,
mx_Appsflyer_MF_App_Campaign, mx_Appsflyer_MF_App_Media_Source,
mx_Stage_change, mx_Stage_Update_URL, mx_MQL_Date

### Product / subscription / plans
mx_Product, mx_Product_Interest, mx_Product_Preference, mx_Prod_to_Pitch,
mx_Plan_ID, mx_Plan_Name, mx_500_Plan, mx_Scheme_Selection,
mx_Subscription__Plans, mx_Subscription_Eligiblity, mx_Subscription_End_dtae,
mx_Latest_Subscription_Name, mx_Algo_Status, mx_StratsDuo, mx_Stock,
mx_Investments, mx_Research_and_Support, mx_Trade_Idea_Support,
mx_Cross_Sell_Opportunity, mx_Cross_Sales_Notes, mx_CS_Trading_Assist

### App / digital engagement
mx_App_Installed, mx_Last_App_Login_Date_Time, mx_Last_Login_Date_Time,
mx_Last_Login_Application, mx_SMS_Counter, mx_WhatsApp_Count,
mx_Client_Last_WhatsApp, mx_GSM_Calling_Data

### Trading profile / survey (voice-of-customer)
mx_Trading_Experience, mx_Trading_Type, mx_Trading_Mode_Used,
mx_Trading_Software_Used, mx_Execution_Style, mx_Market_Knowledge,
mx_How_Long_in_the_Stock_Market,
mx_For_how_long_have_you_been_trading_or_investing,
mx_Daily_Time_Spent_watching_or_trading_the_markets,
mx_How_do_you_primarily_execute_your_trades,
mx_What_best_describes_your_trading_approach,
mx_What_is_your_trading_analysis_preference,
mx_When_you_trade_what_part_do_you_find_difficult,
mx_Customer_Involvement, mx_Preferred_Language

### CSAT / feedback
mx_How_is_the_Experience, mx_Rate_the_overall_experience,
mx_Rate_the_overall_service, mx_Rate_our_Client_Retention_Manager_out_of_5,
mx_Did_your_query_get_resolved, mx_Feedback_on_Strategies, mx_Feedback_on_platform

### Zipteams (3rd-party conversation-intelligence integration)
mx_Zipteams_Capital, mx_ZipTeams_Competitor, mx_Zipteams_Experience_in_Trading,
mx_Zipteams_Preferred_Segment, mx_Zipteams_Registration_Awareness,
mx_Zipteams_Research_Preference, mx_Zipteams_Trading_Style

### Dates / workflow control
mx_Created_Date, mx_Next_Follow_Up_Date_and_Time, mx_Hot_Followup_Date,
mx_Latest_Dealer_Opportunity, mx_Latest_Sales_Opportunity, mx_Opportunity_Type,
mx_5nance_Opportunity, mx_ASC, mx_or

### Test / junk fields (technical debt — DO NOT carry to new CRM)
mx_test, mx_test_field, mx_or, mx_ASC, mx_Subscription_End_dtae (typo),
mx_Presales_Initial_Margin_Commitmnt (typo), mx1_RM_Code (inconsistent prefix)

## KEY TECHNICAL-DEBT SIGNALS FOR THE NEW CRM
1. **Duplicate/near-duplicate fields**: Disposition vs Contacted_Disposition vs
   Phone_call_disposition_2; Objection_or_Concern_* vs Objection_Concern_*;
   Income vs Income_2 vs Annual_Income vs Income_Category;
   Intent_Justification vs Intent_Justification_2;
   Sub_Disposition vs Sub_disposition_2;
   Non_Contactable_Reason vs Non_Contactable_Reasons;
   Path_to_Conversion vs Path_to_Conversion2;
   How_Much_Margin_Pitched vs How_much_margin_pitched_2.
   → Root cause: no field-governance process; new fields created rather than reused.
2. **Client_Code 1..6 repeating group** — a one-to-many relationship flattened into
   6 columns. In the new CRM this is a child entity (Account), not 6 fields.
3. **Typos baked into schema names** (Subscription_End_dtae, Commitmnt) — schema
   names are immutable in LSQ, so errors are permanent. New CRM needs a
   naming/review gate before field creation.
4. **Test fields in production** (mx_test, mx_test_field, mx_or, mx_ASC).
5. **Vendor-specific field namespaces** (mx_Zipteams_*, mx_utm_af*, Appsflyer)
   — integration data written directly onto the core Lead record rather than
   into an integration-owned sub-object.
6. **Denormalised RM data** (RM_Name, RM_Email, RM_Code, RM_Mobile_Number copied
   onto the lead) — should be a lookup to a User/Employee entity.
