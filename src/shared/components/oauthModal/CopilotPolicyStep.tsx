"use client";

import { useTranslations } from "next-intl";
import Icon from "@/shared/components/Icon";
import Button from "@/shared/components/Button";

type CopilotPolicyStepProps = {
  startOAuthFlow: () => void;
  onClose: () => void;
};

/**
 * GitHub Copilot: show the policy-ambiguous / experimental disclosure before
 * starting the device-code flow. The user must click "Connect" to proceed.
 * This satisfies the product requirement that users see the warning before
 * credentials are requested.
 */
export default function CopilotPolicyStep({ startOAuthFlow, onClose }: CopilotPolicyStepProps) {
  const t = useTranslations("oauthModal");

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 p-3 flex gap-2">
        <Icon
          name="warning"
          size={16}
          className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
        />
        <p className="text-sm text-amber-800 dark:text-amber-300 font-medium">
          {t("copilotPolicyTitle")}
        </p>
      </div>

      <ul className="flex flex-col gap-2 text-sm text-text-muted list-none">
        <li className="flex gap-2">
          <Icon name="info" size={14} className="shrink-0 mt-0.5 text-text-secondary" />
          {t("copilotPolicyLine1")}
        </li>
        <li className="flex gap-2">
          <Icon name="person" size={14} className="shrink-0 mt-0.5 text-text-secondary" />
          {t("copilotPolicyLine2")}
        </li>
        <li className="flex gap-2">
          <Icon name="auto_awesome" size={14} className="shrink-0 mt-0.5 text-text-secondary" />
          {t("copilotPolicyLine3")}
        </li>
      </ul>

      <div className="flex flex-col gap-2">
        <Button onClick={startOAuthFlow} fullWidth>
          {t("copilotPolicyAcknowledge")}
        </Button>
        <Button onClick={onClose} variant="secondary" fullWidth>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
