// ITF Asset Checklist — what each checklist asks (moved over unchanged from the
// old Google Sheets "IT Factory Australia Asset Checklist" app's CONFIG).
//
// This is the single source of truth: the server uses it to read the old
// sheet's columns and to fill in Sales Manager items, and the client gets it
// from GET /api/checklist/config to build the forms. Add, remove or reword
// items here and both follow. Renaming an item means entries saved before the
// change keep the old wording (they're stored by label).
//
// Choosing the "ITF Australia" platform adds the device to ITF Sales Manager →
// Inventory on Hand (see checklist.js).
module.exports = {
  cosmeticGrades: [
    {
      code: 'A',
      label: 'Excellent Condition (A)',
      cosmetic: 'As-new condition with minimal to no visible signs of use. May have very light, barely noticeable marks.',
      functional: 'Fully tested and in perfect working order. All features and components operate as expected.'
    },
    {
      code: 'B',
      label: 'Great Condition (B)',
      cosmetic: 'Light signs of use such as minor surface scratches or small scuffs. Clean and well-presented overall.',
      functional: 'Fully tested and in excellent working condition with no impact on performance or usability.'
    },
    {
      code: 'B-',
      label: 'Good Condition (B-)',
      cosmetic: 'Moderate signs of use including light scratches or surface wear. Cosmetic variation is noticeable but remains well-presented.',
      functional: 'Fully tested and working correctly. All core functions operate as expected.'
    },
    {
      code: 'C+',
      label: 'Fair Condition (C+)',
      cosmetic: 'Noticeable signs of use including scratches, scuffs, or light dents. Visibly used but still presentable.',
      functional: 'Fully tested and fully operational. May show minor non-critical wear consistent with normal use.'
    },
    {
      code: 'C',
      label: 'Fair Condition (C)',
      cosmetic: 'Heavier signs of use including more visible scratches, dents, or surface wear.',
      functional: 'Fully tested and functional. May show signs of extended use such as reduced battery performance or minor cosmetic-related wear, while still suitable for everyday use.'
    },
    {
      code: 'D',
      label: 'Poor (D)',
      cosmetic: 'Significant signs of use including heavy scratches, dents, or cosmetic damage and wear consistent with long-term use.',
      functional: 'Fully tested and functional. May show noticeable wear or damage consistent with extended use, but remains suitable for basic use or value-focused buyers.'
    }
  ],

  cosmeticGuidelines: [
    'If a mark/scuff can be completely removed by normal cleaning, do not count it towards the cosmetic grade. Dirt, fingerprints, dust, removable marks or residue do not count as cosmetic damage.',
    'Grade the device after cleaning, based on its overall appearance rather than one isolated mark.',
    'Light scratches/scuffs = normal signs of use; deeper, more visible or numerous marks should receive a lower grade.',
    'Dents, chips, cracks, paint loss or deep scratches are permanent damage and must count towards the cosmetic grade.',
    'A single minor defect does not automatically determine the grade; consider the overall condition of the device.',
    'Check the device under good lighting and inspect all visible surfaces, including the lid, base, sides, palm rest and bezel.',
    'Check screens separately: note scratches, cracks, pressure marks, dead/stuck pixels or other visible display defects.',
    'Cosmetic grade describes appearance only. Functional faults should be recorded separately and must not be overlooked because the device looks good.',
    'Loose/broken hinges, damaged ports, cracked chassis or other structural damage should be treated as a significant issue, not normal cosmetic wear.',
    'If unsure when deciding between two grades, choose the lower grade when the device clearly meets the description of both.'
  ],

  // The options for the Platform dropdown (individual and bulk edit).
  // Selecting "ITF Australia" automatically adds the item to ITF Sales
  // Manager → Inventory on Hand (see checklist.js).
  platformOptions: ['ITF Australia', 'Wholesale'],

  // Options for the "Product Type" dropdown on the "Other IT Equipment"
  // checklist (see deviceTypes.otherEquipment below) — kept matching the
  // "Item Type" dropdown in Sales Manager's Add Inventory
  // Item form, since an entry's Product Type is sent as its Sales Manager
  // item type when synced (see salesItemFor in checklist.js). If
  // Sales Manager's dropdown changes, update this list to match.
  otherEquipmentProductTypes: [
    'Laptop', 'Desktop', 'AIO', 'Tablet', 'Phone', 'Monitor', 'Projector',
    'Dock', 'Cable', 'Hard Drive', 'PC Part', 'Watch', 'Bundle',
    'Accessory', 'Other'
  ],

  deviceTypes: {
    laptop: {
      label: 'Laptop',
      sheetName: 'Laptop',
      assetPrefix: 'LAP',
      salesItemType: 'Laptop', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Capacity', 'RAM', 'CPU', 'PROCESSOR', 'Serial Number', 'Battery Health', 'Ports'],
      // Items listed here are NOT QA pass/fail checks and are excluded from
      // the "X / Y checked" progress count — they're simple yes/no device
      // attributes (does it have this feature at all) rather than "does
      // this feature work". See the "Device Features" section below.
      optionalItems: ['Touchscreen', 'Convertible'],
      sections: [
        {
          title: 'Windows Installation',
          items: [
            'Boot from Windows USB',
            'Delete all partitions (if applicable) & install Windows',
            'Complete Windows setup (OOBE)',
            'Connect to internet',
            'Run Windows Update until fully up to date',
            'Install all required drivers (no unknown devices)',
            'Restart after updates/drivers'
          ]
        },
        {
          title: 'QA Check',
          items: [
            'Boots without errors',
            'Body condition check',
            'Screen check',
            'Sound (speakers & headphone jack if fitted)',
            'Camera & microphone',
            'Keyboard (test all keys)',
            'Trackpad',
            'Wi-Fi & Bluetooth',
            'USB ports',
            'USB-C / Thunderbolt (if fitted)',
            'HDMI / DisplayPort / VGA (if fitted)',
            'SD card reader (if fitted)',
            'Charging & battery charging correctly',
            'Screen free of dead pixels/major defects',
            'Device Manager – no unknown devices',
            'Final restart successful'
          ]
        },
        {
          title: 'Device Features',
          items: [
            'Touchscreen',
            'Convertible'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    desktop: {
      label: 'Desktop',
      sheetName: 'Desktop',
      assetPrefix: 'DSK',
      salesItemType: 'Desktop', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Capacity', 'RAM', 'CPU', 'PROCESSOR', 'Serial Number', 'Battery Health', 'Ports'],
      sections: [
        {
          title: 'Windows Installation',
          items: [
            'Boot from Windows USB',
            'Delete all partitions (if applicable) & install Windows',
            'Complete Windows setup (OOBE)',
            'Connect to internet',
            'Run Windows Update until fully up to date',
            'Install all required drivers (no unknown devices)',
            'Restart after updates/drivers'
          ]
        },
        {
          title: 'QA Check',
          items: [
            'Boots without errors',
            'Body condition check',
            'Sound',
            'USB ports (front & rear)',
            'Ethernet',
            'Wi-Fi & Bluetooth (if fitted)',
            'HDMI / DisplayPort / VGA outputs',
            'Device Manager – no unknown devices',
            'Final restart successful'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    iphone: {
      label: 'iPhone',
      sheetName: 'iPhone',
      assetPrefix: 'IPH',
      salesItemType: 'Phone', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Capacity', 'RAM', 'CPU', 'PROCESSOR', 'Colour', 'Serial Number', 'Battery Health'],
      helpNote: 'Model Number: Settings > General > About > Model Number (tap the value to see the alternate "A..." variation). Model Name is shown above Model Number, and Serial Number is just below it. Capacity is on the same page.',
      sections: [
        {
          title: 'QA Check',
          items: [
            'Powers on normally',
            'Body condition check',
            'Screen check',
            'Charging works',
            'Sound (speaker) - use YouTube',
            'Check headphone jack and mic/speaker ports – make sure nothing is inside them',
            'Volume buttons',
            'Power button',
            'Home button (if applicable)',
            'Face ID / Touch ID (if applicable)',
            'Front camera',
            'Rear camera',
            'Camera zoom check',
            'Touchscreen fully responsive',
            'Wi-Fi & Bluetooth',
            'Cellular check (Mobile page in Settings, or Hotspot can be turned on)',
            'Battery Health checked (if able to)'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    ipad: {
      label: 'iPad',
      sheetName: 'iPad',
      assetPrefix: 'IPD',
      salesItemType: 'Tablet', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Capacity', 'RAM', 'CPU', 'PROCESSOR', 'Colour', 'Serial Number', 'Battery Health'],
      helpNote: 'Model Number: Settings > General > About > Model Number (tap the value to see the alternate "A..." variation). Model Name is shown above Model Number, and Serial Number is just below it. Capacity is on the same page.',
      sections: [
        {
          title: 'QA Check',
          items: [
            'Powers on normally',
            'Body condition check',
            'Screen check',
            'Charging works',
            'Sound (speaker) - use YouTube',
            'Check headphone jack and mic/speaker ports – make sure nothing is inside them',
            'Volume buttons',
            'Power button',
            'Home button (if applicable)',
            'Face ID / Touch ID (if applicable)',
            'Front camera',
            'Rear camera',
            'Camera zoom check',
            'Touchscreen fully responsive',
            'Wi-Fi & Bluetooth',
            'Cellular check (Mobile page in Settings, or Hotspot can be turned on)',
            'Battery Health checked (if able to)'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    monitor: {
      label: 'Monitor',
      sheetName: 'Monitor',
      assetPrefix: 'MON',
      salesItemType: 'Monitor', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Screen Size', 'Serial Number', 'Ports'],
      sections: [
        {
          title: 'QA Check',
          items: [
            'Powers on normally',
            'Body/casing condition check',
            'Screen free of dead pixels/major defects',
            'Image stable (no flicker, lines or discolouration)',
            'Brightness & contrast controls work',
            'All ports work (VGA/HDMI/DisplayPort/USB as fitted)',
            'Built-in speakers (if fitted)',
            'Stand or VESA mount intact and stable',
            'Buttons/on-screen menu responsive',
            'Power cable/adapter included and working'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    aio: {
      label: 'AIO',
      sheetName: 'AIO',
      assetPrefix: 'AIO',
      salesItemType: 'AIO', // exact "Item Type" dropdown value in Sales Manager
      infoFields: ['Make', 'Model', 'Capacity', 'RAM', 'CPU', 'PROCESSOR', 'Serial Number', 'Battery Health', 'Ports'],
      sections: [
        {
          title: 'Windows Installation',
          items: [
            'Boot from Windows USB',
            'Delete all partitions (if applicable) & install Windows',
            'Complete Windows setup (OOBE)',
            'Connect to internet',
            'Run Windows Update until fully up to date',
            'Install all required drivers (no unknown devices)',
            'Restart after updates/drivers'
          ]
        },
        {
          title: 'QA Check',
          items: [
            'Boots without errors',
            'Body condition check',
            'Sound',
            'USB ports (front & rear)',
            'Ethernet',
            'Wi-Fi & Bluetooth (if fitted)',
            'HDMI / DisplayPort / VGA outputs',
            'Device Manager – no unknown devices',
            'Final restart successful'
          ]
        },
        {
          title: 'Final Verification',
          items: [
            'Correct specifications verified',
            'Serial number matches records',
            'Cosmetic grade confirmed',
            'Device cleaned'
          ]
        }
      ]
    },

    // A catch-all for anything that doesn't fit the other types (a
    // projector, a dock, a cable, a hard drive, a watch, etc.) — what's
    // actually relevant varies too much by product to make a fixed
    // checklist useful, so this type has NO checklist sections at all.
    // "Product Type" takes the place of a device-level salesItemType: its
    // per-entry value is what actually gets sent to Sales Manager as the
    // item type when synced (see salesItemFor in checklist.js).
    otherEquipment: {
      label: 'Other IT Equipment',
      sheetName: 'Other IT Equipment',
      assetPrefix: 'OTH',
      salesItemType: 'Other', // fallback only — salesItemFor (checklist.js) prefers the entry's own Product Type
      infoFields: ['Product Type', 'Make', 'Model', 'Serial Number', 'Additional Details'],
      sections: []
    }
  }
};