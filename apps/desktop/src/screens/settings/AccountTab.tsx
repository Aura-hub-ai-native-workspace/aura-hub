import { Card, CardHeader } from '@aura/ui';
import { PageContainer, PageBlock } from '../PageContainer';
import { GoogleAccountPanel } from '../../cloud/GoogleAccount';

/** Settings → Account: the Google account, and the cloud it gives AURA. */
export function AccountTab() {
  return (
    <PageContainer title="Account" subtitle="Your Google account, and where AURA keeps the projects you send to the cloud.">
      <div className="grid grid-cols-12 gap-5">
        <PageBlock className="col-span-12 lg:col-span-7">
          <Card>
            <CardHeader title="Google account" subtitle="Sign in to use your Google storage as AURA's cloud." />
            <div className="pb-1 pt-3"><GoogleAccountPanel /></div>
          </Card>
        </PageBlock>
        <PageBlock className="col-span-12 lg:col-span-5">
          <Card>
            <CardHeader title="Cloud storage" subtitle="Google Drive › AURA Hub" />
            <ul className="space-y-2.5 pt-3 text-[12.5px] leading-relaxed text-text-muted">
              <li>“Send to cloud” on a project saves a dated version in your Drive, in the AURA Hub folder. It uses your Google storage.</li>
              <li>AURA can only see files it created there — never the rest of your Drive.</li>
              <li>Dependencies, build output and secrets such as .env files and private keys are never sent.</li>
              <li>Restoring a version makes a new folder beside the project; your current files are not touched.</li>
            </ul>
          </Card>
        </PageBlock>
      </div>
    </PageContainer>
  );
}
