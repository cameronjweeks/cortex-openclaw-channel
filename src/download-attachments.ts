import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';

export async function downloadAttachments(
  attachments: any[],
  apiUrl: string,
  jwtToken: string,
  log?: any
): Promise<{ localPath: string; attachment: any }[]> {
  const mediaDir = path.join(process.env.HOME || '', '.openclaw', 'media', 'inbound');
  
  // Ensure media directory exists
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  const downloadedFiles: { localPath: string; attachment: any }[] = [];

  for (const attachment of attachments) {
    try {
      const fileId = attachment.url.match(/\/files\/(\d+)/)?.[1];
      if (!fileId) {
        log?.warn?.(`Could not extract file ID from URL: ${attachment.url}`);
        continue;
      }

      // Generate unique filename
      const ext = path.extname(attachment.filename) || '.bin';
      const basename = path.basename(attachment.filename, ext);
      const uniqueFilename = `${Date.now()}-${fileId}-${basename}${ext}`;
      const localPath = path.join(mediaDir, uniqueFilename);

      // Download file from Cortex API
      const downloadUrl = `${apiUrl}${attachment.url}`;
      log?.info?.(`Downloading attachment from: ${downloadUrl}`);

      const response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
        },
      });

      if (!response.ok) {
        log?.error?.(`Failed to download attachment: ${response.status} ${response.statusText}`);
        continue;
      }

      // Save to local file
      const buffer = await response.buffer();
      fs.writeFileSync(localPath, buffer);
      
      log?.info?.(`Saved attachment to: ${localPath} (${buffer.length} bytes)`);

      downloadedFiles.push({
        localPath,
        attachment: {
          ...attachment,
          localPath,
        }
      });

    } catch (error) {
      log?.error?.(`Error downloading attachment ${attachment.filename}:`, error);
    }
  }

  return downloadedFiles;
}