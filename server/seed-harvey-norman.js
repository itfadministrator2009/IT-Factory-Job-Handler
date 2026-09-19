// One-off seed script: creates the "Harvey Norman" project with the HP Printers
// Refresh template, matching the structure of the uploaded PDF exactly, including
// its three conditional-logic cases (evidence-if-blank, answer-if-No, ask-if-signed).
const { v4: uuid } = require('uuid');
const { db } = require('./db');

const template = {
  sections: [
    {
      id: 'site_info',
      title: 'Site Info',
      repeatable: false,
      fields: [
        { id: 'install_job', type: 'text', label: 'Install Job', required: true },
        { id: 'site_location', type: 'text', label: 'Site Location', required: true },
        { id: 'install_start_time', type: 'datetime', label: 'Install Start Time', required: true },
        { id: 'conducted_by', type: 'text', label: 'Conducted by', required: true },
        {
          id: 'reminder',
          type: 'instruction',
          label: "A reminder to our Technicians - this form may change regularly as ours and our client's requirements shift. Please remain diligent in ensuring you are filling out the form correctly.",
        },
        { id: 'location_confirmation', type: 'text', label: 'Location Confirmation', required: true },
      ],
    },
    {
      id: 'printer_install',
      title: 'Install',
      repeatable: true,
      instruction: 'For every Printer you are installing, please add a new Install below.',
      fields: [
        {
          id: 'pre_check',
          type: 'instruction',
          label: "Prior to unpacking and installing, please take a moment to verify the Printer's install location is correct and the department staff are prepared for approximately 40 minutes of Printer downtime.",
        },
        { id: 'department', type: 'text', label: 'On-Site Department where Printer is to be Installed (example: Bedding or Administration)', required: true },
        { id: 'new_printer_details', type: 'text', label: 'Make, Model and Serial Number of the NEW Printer to be installed', required: true },

        { id: 'old_printer_details', type: 'text', label: 'Make, Model, and Serial Number of the Old Printer being collected', required: true },
        // Conditional case 1: "if answer is blank, require evidence" — the notes
        // field is optional, but the photo becomes required whenever it's left blank.
        { id: 'old_config_notes', type: 'textarea', label: "If you can't photograph the old config page, manually note its network settings here (IP, Subnet, Gateway, DNS)" },
        {
          id: 'old_config_photo',
          type: 'photo',
          label: 'Photograph the Configuration Page of the old device',
          requiredIf: { field: 'old_config_notes', empty: true },
        },

        {
          id: 'firmware_check',
          type: 'instruction',
          label: "Before connecting this device to the network, please power it on and verify its Firmware (Futuresmart Bundle Version) is 5.8.1.2. You can check this with a configuration page preview.",
        },
        { id: 'network_settings_photo', type: 'photo', label: 'Photograph the Network Settings from the Configuration Page on the New Printer', required: true },
        { id: 'full_config_photo', type: 'photo', label: 'Print and photograph the FULL configuration pages of the New Printer — including Network Configuration and Fax Test pages (if applicable)', required: true },
        {
          id: 'label_instruction',
          type: 'instruction',
          label: 'Affix the supplied label to the FRONT of the printer in a clear, easy-to-view position — the top left of the front door is recommended.',
        },
        { id: 'label_photo', type: 'photo', label: 'Take a photo of the label affixed to the printer', required: true },
      ],
    },
    {
      id: 'post_install',
      title: 'Post Install',
      repeatable: false,
      fields: [
        { id: 'rubbish_removed', type: 'yesno', label: 'Have you taken away any cardboard, plastic or foam rubbish from the NEW Printer installs?', required: true },
        {
          id: 'discrepancy_note',
          type: 'instruction',
          label: "You may have encountered discrepancies with the existing printers to be collected. If you found extra or couldn't find missing printers, please detail them (Make/Model, S/N) below. Leave blank if none.",
        },
        { id: 'discrepancies', type: 'textarea', label: 'Please detail any discrepancies you encountered with older printers' },
        {
          id: 'data_destruction_note',
          type: 'instruction',
          label: "As part of this project, we need to securely erase each old printer's data and produce a destruction certificate. Capture the serial numbers of all hard drives removed BEFORE the printers go to e-waste, and send them to our Project Manager within 3 days. You do not need to do this on-site.",
        },
        { id: 'confirm_understanding', type: 'yesno', label: 'Please confirm you understand the instructions above', required: true },
        // Conditional case 2: "if answer is No, answer question 4.0"
        {
          id: 'contact_pm_note',
          type: 'instruction',
          label: 'Please contact our project manager if you need further clarification.',
          visibleIf: { field: 'confirm_understanding', equals: 'No' },
        },
      ],
    },
    {
      id: 'site_agreement',
      title: 'Site Agreement',
      repeatable: false,
      fields: [
        { id: 'acknowledgement_form', type: 'photo', label: 'Fill out your Certificate of Acknowledgement Checklist form and attach it here', required: true },
      ],
    },
    {
      id: 'sign_off',
      title: 'Sign Off',
      repeatable: false,
      fields: [
        { id: 'tech_signature', type: 'signature', label: 'Technician Signature', required: true },
        { id: 'tech_sign_date', type: 'date', label: 'Date', required: true },
        {
          id: 'site_signoff_note',
          type: 'instruction',
          label: 'Please hand the device to the Site Contact for their signature. They must provide their name and signature, then answer the question below.',
        },
        { id: 'site_signature', type: 'signature', label: 'Site Contact Signature', required: true },
        { id: 'site_sign_date', type: 'date', label: 'Date', required: true },
        // Conditional case 3: "if signature exists, answer question 3.0"
        {
          id: 'site_contact_satisfied',
          type: 'yesno',
          label: 'Site Contact: As the Site Contact, I am satisfied that this installation was completed successfully in its entirety.',
          visibleIf: { field: 'site_signature', notEmpty: true },
          requiredIf: { field: 'site_signature', notEmpty: true },
        },
      ],
    },
  ],
};

function seed(adminUserId) {
  const existing = db.prepare("SELECT id FROM projects WHERE name = 'Harvey Norman'").get();
  if (existing) {
    console.log('Harvey Norman project already exists, skipping seed.');
    return existing.id;
  }
  const id = uuid();
  db.prepare('INSERT INTO projects (id, name, description, template_json, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'Harvey Norman', 'HP Printers - Harvey Norman Refresh: install of new HP network printers at Harvey Norman client sites.', JSON.stringify(template), adminUserId);
  console.log('Seeded Harvey Norman project:', id);
  return id;
}

module.exports = { seed, template };

// Runnable directly: `node seed-harvey-norman.js` — finds the first admin account
// automatically and seeds the project under their name, then exits.
if (require.main === module) {
  const admin = db.prepare("SELECT id, name FROM users WHERE role IN ('admin','agent') ORDER BY created_at ASC LIMIT 1").get();
  if (!admin) {
    console.error('No admin user found — create an admin account first, then re-run this.');
    process.exit(1);
  }
  const id = seed(admin.id);
  console.log(`Done. Project id: ${id} (created by ${admin.name})`);
  process.exit(0);
}
