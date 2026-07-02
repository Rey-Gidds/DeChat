import { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
}

const variantClasses: Record<Variant, string> = {
  primary: "bg-white text-black hover:bg-neutral-200 border border-white",
  secondary:
    "bg-neutral-900 text-neutral-100 hover:bg-neutral-800 border border-neutral-700",
  ghost:
    "bg-transparent text-neutral-300 hover:bg-neutral-900 border border-transparent hover:border-neutral-800",
  danger:
    "bg-neutral-900 text-neutral-300 hover:bg-neutral-800 border border-neutral-700",
};

const sizeClasses = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-3 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled}
      {...props}
    />
  );
}
