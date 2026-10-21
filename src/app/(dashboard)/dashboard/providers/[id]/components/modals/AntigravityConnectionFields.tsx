import { Input, Select, Toggle } from "@/shared/components";
import { ANTIGRAVITY_CLIENT_PROFILE_OPTIONS } from "@/shared/constants/antigravityClientProfile";

type Translator = (key: string) => string;

export function AntigravityConnectionFields({
  t,
  clientProfile,
  projectId,
  sendProjectHeader,
  onChange,
}: {
  t: Translator;
  clientProfile: string;
  projectId: string;
  sendProjectHeader: boolean;
  onChange: (patch: {
    antigravityClientProfile?: string;
    cloudCodeProjectId?: string;
    antigravitySendProjectHeader?: boolean;
  }) => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-subtle p-4">
      <Select
        label={t("antigravityClientProfileLabel")}
        value={clientProfile}
        options={ANTIGRAVITY_CLIENT_PROFILE_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        onChange={(e) => onChange({ antigravityClientProfile: e.target.value })}
        hint={t("antigravityClientProfileHint")}
      />
      <Input
        label={t("antigravityProjectIdLabel")}
        value={projectId}
        onChange={(e) => onChange({ cloudCodeProjectId: e.target.value })}
        placeholder={t("antigravityProjectIdPlaceholder")}
        hint={t("antigravityProjectIdHint")}
        className="font-mono text-xs"
      />
      <Toggle
        checked={sendProjectHeader}
        onChange={(checked) => onChange({ antigravitySendProjectHeader: checked })}
        label={t("antigravitySendProjectHeaderLabel")}
        description={t("antigravitySendProjectHeaderDescription")}
      />
    </div>
  );
}
