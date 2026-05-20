# Feature Spec -> CRM

**PATH**: `/home/zak/notes/brain-1/Δ/crm`
 
**Overall Goal**: Build an intake workflow for building and updating a CRM in obsidian

## TODOS
---
- [ ] update model usage to infer more info when writing back
- [ ] ensure the model uses more freedom in returning convo starters etc.

## Requirements
---
- Build Template for CRM (in the path labeled "PATH"):
    - Metadata is (Relationship, status (how hot or cold is the relationship), organization, importance, email, role)
    - Should hold crystallized information and recent information with an extras section
- Have three main functions:

### New Contact
---
- Build a new contact by name
- Query using the questionnaire extension in this repo for intake metadata and recent information
- Generate the new template and write the information

### Update Contact 
---
- Search and find person by name (if repeats MUST confirm the correct person)
- Update information on them including metadata and newly learned facts (questionnaire)
- Write this to the correct file and make sure to replace new/timely information with 

### Prep Contact
---
- Search and find person by name (if repeats MUST confirm the correct person)
- Give a brief overview of the person including (but not limited to):
    - Their overall profile
    - ESPECIALLY: there most recently gathered info
    - All with dates
- Potential conversation starters (informal and formal)

## Requirements (cont)
---
- Must use dates for every entry in both NEW and UPDATE
- Whether to use NEW or UPDATE should be inferred by user input context, which mode I am in with path to the file should be clearly displayed
- Should use the already existing questionnaire extension for both NEW and UPDATE
- Always be transparent to the path you are gathering or updating files to
