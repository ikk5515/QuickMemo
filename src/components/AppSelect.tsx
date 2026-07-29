import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { isUnifiedSelectUiEnabled } from "../lib/readViewFeatureFlags";

export type AppSelectProps = ComponentPropsWithoutRef<"select">;

export const AppSelect = forwardRef<HTMLSelectElement, AppSelectProps>(
  ({ className, ...props }, ref) => {
    const unifiedSelectUiEnabled = isUnifiedSelectUiEnabled();

    return (
      <select
        {...props}
        className={[
          unifiedSelectUiEnabled ? "app-select" : "",
          className
        ].filter(Boolean).join(" ") || undefined}
        ref={ref}
      />
    );
  }
);

AppSelect.displayName = "AppSelect";
