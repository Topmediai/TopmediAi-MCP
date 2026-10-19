# Image uploads and references

Uploads require explicit permission to send the specified files to external storage. Current storage URLs may be publicly accessible; do not promise private access or automatic deletion. Never upload credentials, private personal files, or unauthorized images.

## Local configuration

Set `TOPMEDIAI_UPLOAD_ROOT` to a dedicated media directory, generate the installed configuration, refresh the plugin package, and reconnect MCP. No extra upload switch is needed. Example directory: `C:\path\to\upload-inputs`.

The plugin accepts PNG/JPEG files of up to 5 MiB inside that directory. It checks the actual format, dimensions, decoding, directory boundaries, and symbolic links, then removes image metadata. Failed or uncertain uploads are not automatically retried.

## Using references

After calling `upload_reference_image`, use its `reference_image_id` for image-to-image, first-frame or first/last-frame video, or multiple-image reference quotes. The selected model must support the requested operation. Read reference counts, dimensions, and roles from the current catalog.

Reference IDs are valid only in the local records for the current account and environment. Never guess IDs, reuse them across accounts, or substitute raw URLs. Quotes bind the media and its digest; changed media requires a new quote.

Local account isolation does not provide cloud access control. The storage service determines access scope and retention. An expired or deleted local record does not mean the cloud object was deleted. Production direct APIs validate account, configuration, and model capabilities; legacy gateway mode does not support reference image uploads.

See [Data and privacy](privacy.md).
