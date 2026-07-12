# shots/

Screenshots were captured live during the walkthrough but the Claude-in-Chrome
capture path in this session did not persist image files to disk. Every screen,
dialog, toolbar, dropdown and interaction is instead transcribed exhaustively in
../report.md (the report was written to be rebuildable without images).

To produce PNGs: re-run the same walkthrough with a capture path that writes files,
naming them NN-area-description.png in walkthrough order, e.g.
  01-login.png
  02-home-dashboard.png
  10-patientmanage-datalist.png
  20-cbct-implant-default.png
  21-cbct-implant-bank-brands.png
  30-cbct-ai-analytics-teeth.png
  31-cbct-mpr-tooth-findings.png
  40-cbct-report-builder.png
  50-cr-viewer-ai-diagnosis.png
  60-ios-occlusal-contact.png
  70-invite-room-dialog.png
  80-laborder-prosthodontics.png
Remember to crop/blur any real patient name/DOB before committing.
