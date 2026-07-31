/**
 * CreationProgress — visual progress indicator for the 9-stage mission
 * creation pipeline.
 */
import { Badge } from '@aura/ui';
import type { CreationStage } from './useMissions';
import type { IntentClassification, MissionStrategy } from '../../ai/missionClient';

const STAGE_ORDER: CreationStage[] = [
  'classify',
  'signals',
  'intent',
  'strategy',
  'goal-graph',
  'risk',
  'review',
  'quality',
  'done',
];

const STAGE_LABEL: Record<CreationStage, string> = {
  idle: '',
  classify: 'Classifying intent…',
  signals: 'Gathering real project signals…',
  intent: 'Extracting intent…',
  strategy: 'Selecting mission strategy…',
  'goal-graph': 'Building Goal Graph…',
  risk: 'Analyzing risk…',
  review: 'Adversarial review…',
  quality: 'Scoring plan quality…',
  done: 'Done',
  error: 'Failed',
};

function StageDot({ stage, current }: { stage: CreationStage; current: CreationStage }) {
  const completed = STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(current);
  const isCurrent = stage === current;
  const isError = current === 'error';

  if (isError) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-2 w-2 rounded-full bg-danger" />
        <span className="text-[11px] text-danger">{STAGE_LABEL[current]}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`h-2 w-2 rounded-full ${
          completed ? 'bg-positive' : isCurrent ? 'bg-accent' : 'bg-line'
        }`}
      />
      <span
        className={`text-[11px] ${
          completed ? 'text-text-subtle' : isCurrent ? 'text-text' : 'text-text-muted'
        }`}
      >
        {STAGE_LABEL[stage]}
      </span>
    </div>
  );
}

export function CreationProgress({
  stage,
  classification,
  strategy,
}: {
  stage: CreationStage;
  classification: IntentClassification | null;
  strategy: MissionStrategy | null;
}) {
  const currentIndex = STAGE_ORDER.indexOf(stage);
  const showDetails = currentIndex >= STAGE_ORDER.indexOf('strategy');

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="mb-6 text-center">
        <h2 className="text-[15px] font-semibold text-text">Creating Mission Plan</h2>
        <p className="mt-1 text-[12px] text-text-muted">
          Building a grounded plan through a 9-stage pipeline
        </p>
      </div>

      <div className="mb-6 flex flex-col gap-2">
        {STAGE_ORDER.map((s) => (
          <StageDot key={s} stage={s} current={stage} />
        ))}
      </div>

      {showDetails && (
        <div className="w-full max-w-[400px] space-y-4 rounded-xl border border-line bg-canvas p-4 text-left">
          {classification && (
            <div>
              <div className="text-[10.5px] font-medium text-text-muted mb-1">Category</div>
              <Badge tone="info">{classification.category}</Badge>
              <span className="ml-2 text-[11px] text-text-subtle">
                Confidence: {Math.round(classification.confidence * 100)}%
              </span>
            </div>
          )}
          {strategy && (
            <div>
              <div className="text-[10.5px] font-medium text-text-muted mb-1">Strategy</div>
              <div className="text-[12px] text-text">{strategy.guidance}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {strategy.focusAreas.map((fa) => (
                  <Badge key={fa.id} tone="neutral">
                    {fa.label}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {stage === 'error' && (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3">
          <p className="text-[12px] text-danger">Mission creation failed. Please try again.</p>
        </div>
      )}
    </div>
  );
}
