import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const title = 'MyAgentRoam Enterprise Source-Available License 1.0';
const requiredSections = [
  '1. Parties and acceptance',
  '2. Covered software and independent components',
  '3. Internal use and development grant',
  '4. Enterprise features and activation',
  '5. Prohibited redistribution and external operation',
  '6. Notices, modifications and trademarks',
  '7. Data and output',
  '8. Contributions and patents',
  '9. Breach and termination',
  '10. Warranty disclaimer',
  '11. Liability',
  '12. Applicable law, language and remaining rights'
];

export async function checkProductLicense(directory = resolve(import.meta.dirname, '..')) {
  let license;
  try {
    license = (await readFile(resolve(directory, 'ee/LICENSE'), 'utf8'))
      .replaceAll('\r\n', '\n')
      .trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PRODUCT_LICENSE_NOT_APPROVED');
    throw error;
  }
  // Validate release text structure, not legal enforceability or ownership.
  const sections = [...license.matchAll(/^\d+\. .+$/gmu)];
  if (
    !license.startsWith(`${title}\n`) ||
    !license.includes('\nLocal license identifier: LicenseRef-MAR-ESAL-1.0\n') ||
    /\b(?:DRAFT|NOT EFFECTIVE|PENDING_APPROVAL)\b/u.test(license) ||
    sections.length !== requiredSections.length ||
    sections.some(
      (section, index) =>
        section[0] !== requiredSections[index] ||
        !license
          .slice(section.index + section[0].length, sections[index + 1]?.index ?? license.length)
          .trim()
    )
  )
    throw new Error('PRODUCT_LICENSE_NOT_APPROVED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await checkProductLicense();
