export async function runAstroDocs(data: any): Promise<any> {
  return { status: "AstroDocs script slot ready", received: data };
}

export async function runAstroSlides(data: any): Promise<any> {
  return { status: "AstroSlides script slot ready", received: data };
}

export async function runAstroVeo(data: any): Promise<any> {
  return { status: "AstroVeo script slot ready", received: data };
}

export async function runAstroNotes(data: any): Promise<any> {
  return { status: "AstroNotes script slot ready", received: data };
}

export async function runAstroQuiz(data: any): Promise<any> {
  return { status: "AstroQuiz script slot ready", received: data };
}