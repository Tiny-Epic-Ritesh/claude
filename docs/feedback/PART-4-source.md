# Bonanza CRM Feedback Part 4

## Implementation objective

Implement the following improvements to case management, lead ownership, product engagement, calling, and pipeline filtering. Preserve the business intent of each requirement and use the existing CRM configuration wherever the feedback refers to escalation rules, SLA behaviour, product stages, or assignment rules.

Each numbered section corresponds to the same feedback item in the original document. Complete the verification checks after implementing each change.

## 1. Add confirmation dialogs for case escalation and resolution

**Location:** Case detail page.

### Escalate

Clicking **Escalate** currently escalates the ticket immediately. Display a confirmation dialog before performing the action.

The dialog must:

- Clearly state that the ticket will be escalated.
- Summarise the applicable escalation matrix, including the recipient at each level and the relevant time limits.
- Explain what happens if the ticket remains unresolved.
- Provide **Confirm** and **Cancel** buttons.

Escalate the ticket only after the user clicks **Confirm**.

### Mark Resolved

Display a confirmation dialog when the user clicks **Mark Resolved**.

The dialog must:

- Clearly state that the ticket will be marked as resolved.
- Summarise relevant actions from the ticket history and current ticket details.
- Suggest any checks or actions the user should complete before resolving the ticket.
- Provide **Confirm** and **Cancel** buttons.

Mark the ticket as resolved only after the user clicks **Confirm**.

**Verification checks**

- Opening either dialog does not change the ticket.
- Cancelling either action leaves the ticket unchanged.
- The escalation summary reflects the applicable escalation configuration.
- Confirming performs the selected action and clearly communicates the outcome.

## 2. Limit the conversations displayed on the case detail page

**Location:** Conversation panel on the case detail page.

Display a maximum of **50 conversation entries** in the main conversation panel.

Provide a **Show More** button that opens a scrollable view containing the complete conversation history. Users must be able to scroll through and read all conversations associated with the ticket.

**Verification checks**

- The main panel displays no more than 50 entries.
- For tickets with more than 50 entries, **Show More** provides access to the complete history.
- Conversation details remain readable in the expanded view.

## 3. Improve the Manage section and explain internal notes

**Location:** Case detail page.

### 3.1 Save and confirm changes to case fields

The **Manage** section contains **Status**, **Priority**, and **Assignee** dropdowns.

After a user changes any of these fields, provide a **Save** button. When the user clicks **Save**, display a confirmation dialog before applying the changes.

The dialog must:

- Summarise the proposed changes.
- Describe relevant actions or checks the user should complete before changing the status, priority, or assignee.
- Explain the applicable impact of moving the ticket to the selected status or priority.
- Provide **Save** and **Cancel** buttons.

Apply the changes only after the user clicks **Save** in the dialog.

### 3.2 Improve field layout and SLA helper text

Improve the layout of the **Status**, **Priority**, and **Assignee** fields.

The message explaining that **Waiting on Client** pauses the SLA clock currently appears too close to the Priority field and uses similar text sizing. This makes it difficult to distinguish the helper message from the field labels.

- Position the SLA helper message clearly with the Status field when **Waiting on Client** is selected.
- Use appropriate spacing, text size, and visual hierarchy.
- Ensure that field labels, selected values, and helper text are easy to distinguish.

Suggested helper text:

> Moving this ticket to "Waiting on Client" pauses the SLA clock.

### 3.3 Explain the Internal note checkbox

When a user selects **Internal note** in the conversation panel, display a short explanation of its purpose and visibility.

Suggested message:

> Internal notes are for your team's reference only. They are not shared with the client or customer.

**Verification checks**

- Dropdown changes are not committed before confirmation.
- Cancelling the confirmation does not persist the proposed changes.
- The dialog accurately summarises the changes.
- The SLA helper text is clearly associated with Status.
- Selecting **Internal note** displays the visibility explanation.

## 4. Verify and improve Run SLA Sweep

**Location:** Tickets home page.

Clicking **Run SLA Sweep** currently produces no visible response. Inspect the existing implementation to determine whether the action is functional.

- If the functionality already exists, make its purpose and outcome visible to the user.
- If it is incomplete or non-functional, implement or repair it according to the CRM's SLA rules.
- Explain what the action does and what changes it may trigger.
- Display an information or warning dialog before running the sweep.
- Require confirmation before execution.
- After execution, show a clear result or error message.

Restyle the button with rounded corners consistent with the other controls. Ensure that it is readable and visually consistent in both light and dark modes.

**Verification checks**

- The user can understand the purpose of the action before running it.
- Cancelling the confirmation does not run the sweep.
- Confirming runs the intended SLA processing.
- The user receives a visible outcome, including when there are no applicable updates or when the action fails.
- The button and dialogs display correctly in both themes.

## 5. Make case summary cards clickable

**Location:** Cases tab on the tickets home page.

Make the following summary cards clickable:

| Summary card | Expected drill-down |
| --- | --- |
| Open tickets | Display the open tickets represented by the count. |
| Breached tickets | Display the breached tickets represented by the count. |
| Resolved today | Display the tickets represented by today's resolved count. |
| Average CSAT | Provide a relevant drill-down into the records contributing to the displayed average. See the open decision below. |

Open the relevant records in a new tab or a dedicated case summary page.

For example:

- If **Open tickets** shows **4**, clicking the card or count should open those four tickets.
- If **Breached tickets** shows **6**, clicking the card or count should open those six breached tickets.

**Verification checks**

- Each card opens the relevant records.
- The drill-down uses the same criteria as the displayed summary.
- Users can open individual tickets from the resulting view.

**Open decision:** The original feedback does not specify the exact destination for **Average CSAT**. Confirm whether this should open contributing cases, individual feedback records, or an existing CSAT report before selecting a destination.

## 6. Standardise date formatting throughout CRM

Display all dates throughout CRM in **DD-MM-YYYY** format.

This applies to fields such as:

- Created On
- Next Follow-up Date
- Modified On
- All other date fields displayed in CRM

Include the time wherever it is applicable to the field.

**Verification checks**

- Dates use **DD-MM-YYYY** consistently across CRM.
- Fields that require a time continue to display it.
- Formatting changes preserve the underlying date and time values.

**Open decision:** The feedback does not specify a time format or timezone. Retain the existing configured time format and timezone unless a separate change is agreed.

## 7. Restrict lead ownership during creation by a Sales RM

**Location:** New lead creation.

When a salesperson or Sales RM creates a lead:

- Set **Owner** to the logged-in user by default.
- Display that user's name in the Owner field.
- Prevent the user from selecting another owner during lead creation.
- Save the lead with the creating user as its owner.

**Verification checks**

- The Owner field defaults to the logged-in salesperson.
- The salesperson cannot assign the new lead to another user during creation.
- The saved lead belongs to the creating salesperson.

## 8. Improve product engagement actions and Product RM handover

**Location:** Product cards on the lead.

### 8.1 Make stage transitions clear and engaging

Improve the presentation of **Start Engaging**, the highlighted next action, and **Other Moves** so users can understand the available stage transitions.

The current flow and options mentioned in the feedback include:

- Exploring
- Mark Warm
- Request Product RM / Bring in Product RM
- Product RM engaged
- KYC in progress
- On Hold
- Lost

The existing highlighted next-step treatment is useful and should be retained where appropriate.

Improve the experience so that:

- The current product stage is clear.
- The recommended next action is easy to identify.
- All available alternative moves are easy to discover and understand.
- Users can choose an appropriate transition based on their conversation and engagement with the lead.
- **Other Moves** is presented as a clear, engaging set of valid actions.

Use the existing valid transition rules; the stages listed above describe the feedback and do not define a new transition matrix.

### 8.2 Explain Product RM involvement

Make **Request Product RM** or **Bring in Product RM** more informative.

The user should understand:

- What clicking the button will do.
- Which Product RM is assigned or how the assignment is determined.
- What task or other background action will be created.
- How the lead owner can share context with the Product RM.

Provide a way for the lead owner to share relevant handover information, including:

- The current lead and product status.
- A summary of conversations with the lead.
- Information the Product RM needs before approaching the lead.

Support communication between the lead owner and the Product RM so the Product RM has a clear understanding of the engagement.

### 8.3 Explain automatic task creation

Clicking **Request Product RM** currently creates a task without clearly informing the user.

Display a pop-up or notification explaining the action taken, including the task creation and any other actual outcomes of the request.

### 8.4 Provide action feedback throughout CRM

Apply the same principle to action buttons throughout CRM.

When an action is initiated or completed, clearly explain its actual outcome. For example, tell the user when a task has been created, an activity has been scheduled, or another operation has completed.

Use an appropriate pop-up, notification, or message. Users must be able to acknowledge or dismiss the message using **OK**, a close control, or an equivalent interaction.

**Verification checks**

- Users can identify the current stage and available next moves.
- Product RM involvement and assignment are understandable.
- The lead owner can provide handover context.
- Automatic task creation is clearly communicated.
- Relevant action buttons provide visible feedback that matches the action actually performed.

## 9. Review and improve the Start Call pop-up

**Location:** Lead Details > Start Call.

**Reference:** The screenshot embedded under item 9 on page 3 of the original feedback document.

Review why clicking **Start Call** opens the current pop-up and determine whether the pop-up is needed for the calling workflow.

The reported issues are:

- The pop-up's purpose and value are unclear.
- A control beside the live call timer appears to be invisible or difficult to see.
- The displayed products are irrelevant or not useful in the calling context.
- In light mode, the pop-up appears insufficiently opaque, allowing the screen behind it to show through and reducing readability.
- The interface does not clearly explain what happens after the user clicks **Start Call**.

If the pop-up is required:

- Make its purpose clear.
- Fix the visibility of the control beside the timer.
- Review the product information and show only information useful to the caller.
- Correct the modal background, opacity, layering, and contrast in light mode.
- Make the screen more informative, detailed, and engaging.
- Clearly explain the current call state and the actions available to the caller.

If the pop-up is unnecessary, simplify the flow while preserving the required calling functionality and giving the user clear feedback.

**Verification checks**

- Clicking **Start Call** has a clear, understandable outcome.
- Required call controls are visible and usable.
- Any retained pop-up has a readable surface and clear separation from the underlying page.
- Displayed information supports the calling task.
- The calling interface works visually in both light and dark modes.

## 10. Add a multi-select product filter to Pipeline

**Location:** Pipeline tab > Products control.

Provide a **multi-select dropdown** containing the available products.

Allow users to select several products and view the pipeline results for that selection. For example, a user should be able to select three or four products, or five or six products, instead of viewing every product.

**Verification checks**

- Users can select more than one product at a time.
- The selected products are clearly indicated.
- The displayed pipeline results match the selected products.

## 11. Add quick filters within Pipeline stages

**Location:** Product stages in the Pipeline tab.

Provide quick, useful filters and lead search for each of these stages:

- Exploring
- Warm
- Product RM engaged
- KYC in progress
- Active

Users may eventually have more than **1,000 or 2,000 leads** in a single stage. They must be able to locate relevant leads without manually scrolling through every record.

**Verification checks**

- Each listed stage provides accessible filtering and lead search.
- Filtering returns the relevant leads within the selected stage.
- Users can narrow down large stage lists without browsing every lead.

**Open decision:** The feedback does not define the individual quick-filter fields. Identify suitable fields from the existing CRM and confirm the proposed set before finalising these controls.

## Completion report

After implementation, provide:

- A status against each of the 11 feedback items.
- A brief description of the changes.
- The verification performed and its results.
- Any remaining defects or open decisions.

