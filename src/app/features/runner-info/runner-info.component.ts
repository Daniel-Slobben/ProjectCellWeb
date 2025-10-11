import {ChangeDetectorRef, Component} from '@angular/core'
import {HttpClient} from '@angular/common/http';

@Component({
  selector: 'runner-info', standalone: true, template: `
    <div class="p-4 border rounded bg-white shadow">
      <h3 class="text-lg font-bold mb-2">Runner Info</h3>
      <p>Amount of blocks in Memory: {{ runnerState.blocksInMemory}}</p>
      <p>Amount of blocks Updating: {{ runnerState.blocksUpdating}}</p>
    </div>
  `
})
export class RunnerInfoComponent {
  runnerState!: state;
  constructor(private httpClient: HttpClient, private changeDetectorRef: ChangeDetectorRef) {
    setInterval(() => {
      this.updateRunnerInfo();}, 1000);
  }

  public updateRunnerInfo(): void {
    console.log("trying state info update");
    this.httpClient.get<state>('/gen-api/state-info').subscribe((state) => {
      this.runnerState = state;
    })
    this.changeDetectorRef.detectChanges();
  }
}

export interface state {
  blocksInMemory: number;
  blocksUpdating: number;
}
