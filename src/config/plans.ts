export interface PlanFeatures {
  bugPass: boolean;
  designPass: boolean;
  performancePass: boolean;
  fixSuggestions: boolean;
  riskScoring: boolean;
  reviewerSuggestions: boolean;
  customRules: boolean;
  ragContext: boolean;
}

export interface PlanDefinition {
  slug: string;
  name: string;
  reviewsPerMonth: number; // 0 = unlimited
  features: PlanFeatures;
}

export const PLANS: Record<string, PlanDefinition> = {
  free: {
    slug: "free",
    name: "Free",
    reviewsPerMonth: 50,
    features: {
      bugPass: true,
      designPass: true,
      performancePass: false,
      fixSuggestions: false,
      riskScoring: false,
      reviewerSuggestions: false,
      customRules: false,
      ragContext: false,
    },
  },
  pro: {
    slug: "pro",
    name: "Pro",
    reviewsPerMonth: 500,
    features: {
      bugPass: true,
      designPass: true,
      performancePass: true,
      fixSuggestions: true,
      riskScoring: true,
      reviewerSuggestions: false,
      customRules: true,
      ragContext: true,
    },
  },
  team: {
    slug: "team",
    name: "Team",
    reviewsPerMonth: 0,
    features: {
      bugPass: true,
      designPass: true,
      performancePass: true,
      fixSuggestions: true,
      riskScoring: true,
      reviewerSuggestions: true,
      customRules: true,
      ragContext: true,
    },
  },
};

export const getPlan = (slug: string): PlanDefinition => PLANS[slug] ?? PLANS.free;
