import type { UserSubject } from '@gitcolony/auth/subjects';

// See https://svelte.dev/docs/kit/types#app
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      user?: UserSubject;
    }
    interface PageData {
      user?: UserSubject;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
