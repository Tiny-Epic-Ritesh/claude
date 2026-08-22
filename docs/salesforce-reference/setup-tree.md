# Salesforce Setup — Information Architecture (verified from org)

Org: mindful-moose-72ar4m-dev-ed (Trailhead Developer Edition)
Setup domain pattern: `<mydomain>.my.salesforce-setup.com/lightning/setup/<PageName>/home`

Setup is split into THREE top-level groupings, then categories, then leaf pages.
Above the tree sits a persistent **Quick Find** search box — the primary
navigation method for admins (nobody browses this tree; they search it).

Two fixed tabs at the top: **Home** | **Object Manager**

## ADMINISTRATION
### Users
- Analytics Groups
- Permission Set Groups
- Permission Sets
- Profiles
- Public Groups
- Queues
- Roles
- User Management Settings
- Users
### Data
### Email

## PLATFORM TOOLS
### Apps
### Feature Settings
- Analytics · Approval Settings · Chatter · Data.com · Digital Experiences
- **Field History Tracking**
- Functions · Headless Experience Layer Settings · Home · Marketing
- Omnichannel Inventory · Payments · Quip · Sales · Salesforce Files
- Salesforce IoT · Scheduled Reminders · Service · Survey · Topics
### Slack
- Manage Slack Connection · Slack Apps Setup · Slack Channels for Records
### Workflow Services
- Batch Management · Monitor Workflow Services
### Data Cloud / Heroku / MuleSoft / Einstein
- Data Cloud Setup Home
- About Heroku · Apps
- Anypoint Platform Setup · Integration Intelligence
- Einstein Platform · Einstein Sales · Einstein Search · Opt Out of Customer Data Access
### Objects and Fields
- **Object Manager**
- **Picklist Value Sets**
- **Schema Builder**
### Events
- Event Manager · Event Relays · Event Studio
### Process Automation
- **Approval Processes**
- Automation App
- **Flows**
- Migrate to Flow
- Next Best Action
- **Paused And Failed Flow Interviews**
- Post Templates
- Process Automation Settings
- Process Builder (legacy)
- Workflow Actions
- Workflow Rules (legacy)
### User Interface
- Action Link Templates · Actions & Recommendations · App Menu
- Console Settings · Custom Labels · Density Settings
- **Global Actions**
- **Lightning App Builder**
- Lightning Extension
- **Path Settings**
- Quick Text Settings · Record Page Settings
- Rename Tabs and Labels
- Sites and Domains
- **Tabs**
- Themes and Branding
- Translation Workbench
- User Interface
### Custom Code
- Apex Classes · Apex Settings · Apex Triggers
- Application Test Execution · Application Test History
- Canvas App Previewer
- **Custom Metadata Types**
- **Custom Permissions**
- **Custom Settings**
- Static Resources · Tools · Visualforce Components · Visualforce Pages
### Development
- Agentforce Vibes Extension · Dev Hub · DevOps Center · Scratch Orgs · Web Console
### Scale / Environments
- Scale Test
- Deploy · Jobs · Logs · Monitoring · System Overview
### User Engagement
- Adoption Assistance · Guidance Center · Help Menu · In-App Guidance
### Integrations
- **API**
- API Catalog
- **Change Data Capture**
- Data Import Wizard · Data Loader · Dataloader.io
- **External Data Sources** · **External Objects** · **External Services**
- Named Query API
- **Platform Events**
- Teams Integration
### Notification Builder
- Custom Notifications · Notification Delivery Settings
### Offline
- Briefcase Builder
### Go Accelerate
- Solution Deployment Monitoring

## SETTINGS
- Company Settings
- Data Classification
- Privacy Center
- Data Mask
- Identity
- **Security**

---

## Design lessons from the IA itself

1. **Search-first, not browse-first.** Quick Find is the primary entry point.
   With this many settings, a tree alone is unusable. Any admin console for the
   new CRM needs a searchable settings index from day one.
2. **Object Manager is a peer of Home, not buried in the tree.** Schema editing
   is the single most common admin task, so it gets top-level placement.
3. **Legacy tools are visibly deprecated in place** — "Process Builder" and
   "Workflow Rules" sit alongside "Flows" plus an explicit **"Migrate to Flow"**
   tool. Salesforce ships a migration path rather than silently leaving two
   engines running. Compare LeadSquared, where V3/V4 forms coexist with no
   migration path.
4. **Separation of concerns is legible in the grouping**: who can do things
   (Administration) / what the system is (Platform Tools) / how the org behaves
   (Settings).
