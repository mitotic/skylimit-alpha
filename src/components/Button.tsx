import React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger'
  children: React.ReactNode
}

export default function Button({ variant = 'primary', ...props }: ButtonProps) {
  const baseClasses = 'btn'
  const variantClasses = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    danger: 'btn-danger',
  }

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${props.className || ''}`}
      {...props}
    >
      {props.children}
    </button>
  )
}




