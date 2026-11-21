// Field Estimate — configuration
// Leave SUPABASE_URL empty to run in DEMO MODE (data saved only on this device).
// Fill both values in to use the real shared database (see README, step 2).
window.FE_CONFIG = {
  SUPABASE_URL: "",        // e.g. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "",   // Project Settings -> API -> anon public key
  EXTRACT_FUNCTION: "extract-job", // Supabase Edge Function name for PDF reading
  COMPANY_NAME: "Your Company",
  COMPANY_LINE: "Pre-listing repairs",
  MAX_VIDEO_MB: 50,        // videos larger than this are refused (Supabase free plan limit is 50 MB per file)
  PHOTO_MAX_PX: 1600       // photos are shrunk to this size before upload
};
