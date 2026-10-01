export interface User {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface Chat {
  id: number
  type: string
}

export interface SuccessfulPayment {
  currency: string
  total_amount: number
  invoice_payload: string
  subscription_expiration_date?: number
  is_recurring?: true
  is_first_recurring?: true
  telegram_payment_charge_id: string
  provider_payment_charge_id: string
}

export interface RefundedPayment {
  currency: string
  total_amount: number
  invoice_payload: string
  telegram_payment_charge_id: string
  provider_payment_charge_id?: string
}

export interface Invoice {
  title: string
  description: string
  start_parameter: string
  currency: string
  total_amount: number
}

export interface Message {
  message_id: number
  from?: User
  chat: Chat
  date: number
  text?: string
  invoice?: Invoice
  successful_payment?: SuccessfulPayment
  refunded_payment?: RefundedPayment
}

export interface PreCheckoutQuery {
  id: string
  from: User
  currency: string
  total_amount: number
  invoice_payload: string
}

export interface SubscriptionUpdate {
  user: User
  invoice_payload: string
  state: 'canceled' | 'active' | 'failed'
}

export interface Update {
  update_id: number
  message?: Message
  pre_checkout_query?: PreCheckoutQuery
  subscription?: SubscriptionUpdate
}

export interface TransactionPartner {
  type: string
  transaction_type?: string
  user?: User
  invoice_payload?: string
  subscription_period?: number
}

export interface StarTransaction {
  id: string
  amount: number
  nanostar_amount?: number
  date: number
  source?: TransactionPartner
  receiver?: TransactionPartner
}
