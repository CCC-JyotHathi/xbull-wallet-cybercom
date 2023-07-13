import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ComponentFactoryResolver,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewContainerRef,
} from '@angular/core';
import {
  BehaviorSubject,
  combineLatest,
  from,
  Observable,
  of,
  Subject,
  Subscription,
} from 'rxjs';
import {
  IWalletAssetModel,
  WalletsAccountsQuery,
  WalletsAssetsQuery,
  WalletsOffersQuery,
  WalletsQuery,
} from '~root/state';
import {
  debounceTime,
  delay,
  map,
  switchMap,
  take,
  takeUntil,
} from 'rxjs/operators';
import {
  AbstractControl,
  UntypedFormControl,
  UntypedFormGroup,
  Validators,
} from '@angular/forms';
import { AccountResponse, ServerApi } from 'stellar-sdk';
import { WalletsAssetsService } from '~root/core/wallets/services/wallets-assets.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { StellarSdkService } from '~root/gateways/stellar/stellar-sdk.service';
import { NzDrawerRef, NzDrawerService } from 'ng-zorro-antd/drawer';
import { WalletsOffersService } from '~root/core/wallets/services/wallets-offers.service';
import { ActivatedRoute } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { AssetSearcherComponent } from '~root/shared/asset-searcher/asset-searcher.component';
import BigNumber from 'bignumber.js';
import { XdrSignerComponent } from '~root/shared/modals/components/xdr-signer/xdr-signer.component';
import QrScanner from 'qr-scanner';
import { QrScanModalComponent } from '~root/shared/modals/components/qr-scan-modal/qr-scan-modal.component';
import { validPublicKeyValidator } from '~root/shared/forms-validators/valid-public-key.validator';
import { PasswordModalComponent } from '~root/shared/modals/components/password-modal/password-modal.component';
import { CryptoService } from '~root/core/crypto/services/crypto.service';

@Component({
  selector: 'app-path-payment-form',
  templateUrl: './path-payment-form.component.html',
  styleUrls: ['./path-payment-form.component.scss'],
})
export class PathPaymentFormComponent
  implements OnInit, AfterViewInit, OnDestroy
{
  @Input() mode: 'swap' | 'payment' = 'swap';
  @Input() cardTitle?: string;
  @Input() sendLabelText?: string;
  @Input() receiveLabelText?: string;
  @Input() confirmButtonText?: string;
  // @ViewChild(XdrSignerComponent, { static: true })
  // xdrSigner!: XdrSignerComponent;

  hasCamera = from(QrScanner.hasCamera());
  rangeRegex = /^\d+\.?\d*\-\d+\.?\d*$/;
  swapRateDetails = {
    fromAmount: 0,
    toAmount: 1,
  };
  swapRangeValues = {
    min: 0,
    max: 0,
  };

  componentDestroyed$: Subject<void> = new Subject<void>();
  selectedWalletAccount$ = this.walletAccountsQuery.getSelectedAccount$;

  gettingPathPaymentRecord$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);
  sendingPathPayment$ = this.walletOffersQuery.sendingPathPayment$;
  swapAssets$: Subject<void> = new Subject<void>();
  confirmingSwapAssets$: BehaviorSubject<boolean> =
    new BehaviorSubject<boolean>(false);

  myAssets$: Observable<IWalletAssetModel[]> = this.selectedWalletAccount$.pipe(
    switchMap((selectedWalletAccount) => {
      if (!selectedWalletAccount || !selectedWalletAccount.accountRecord) {
        return of([]);
      }

      const assetsIds = this.walletsAssetsService
        .filterBalancesLines(selectedWalletAccount.accountRecord.balances)
        .map((b) => this.walletsAssetsService.formatBalanceLineId(b));

      return this.walletsAssetsQuery.getAssetsById(assetsIds);
    })
  );

  isValidateRange = (rangeString: string) => {
    if (rangeString && this.rangeRegex.test(rangeString)) {
      const rangePoints = rangeString.split('-');
      const startPoint = Number.parseFloat(rangePoints[0]);
      const endPoint = Number.parseFloat(rangePoints[1]);
      if (startPoint < endPoint) {
        this.swapRangeValues.min = startPoint;
        this.swapRangeValues.max = endPoint;
        return true;
      } else {
        return false;
      }
    }
    return false;
  };

  fromAssetValidator = (control: AbstractControl) => {
    if (!this.isValidateRange(control.value.toString())) {
      return { isValidRange: false };
    } else {
      return null;
    }
  };

  toAssetValidator = (control: AbstractControl) => {
    if (!this.isValidateRange(control.value.toString())) {
      return { isValidRange: false };
    } else {
      return null;
    }
  };
  swapForm: UntypedFormGroup = new UntypedFormGroup({
    destination: new UntypedFormControl(''),
    memo: new UntypedFormControl(''),
    fromAsset: new UntypedFormGroup(
      {
        amount: new UntypedFormControl(0, [
          Validators.required,
          Validators.min(0.0000001),
        ]),
        asset: new UntypedFormControl('', [Validators.required]),
      },
      [Validators.required]
    ),
    toAsset: new UntypedFormGroup(
      {
        amount: new UntypedFormControl(0, [
          Validators.required,
          Validators.min(0.0000001),
          this.toAssetValidator,
        ]),
        asset: new UntypedFormControl('', [Validators.required]),
      },
      [Validators.required]
    ),
    pathType: new UntypedFormControl('send', [Validators.required]),
    slippageTolerance: new UntypedFormControl(0.005, [Validators.required]),
    path: new UntypedFormControl(undefined, [Validators.required]),
    exchangeRate: new UntypedFormControl(undefined, [Validators.required]),
    continuousTransactionState: new UntypedFormControl(false),
  });

  get destination(): UntypedFormControl {
    return this.swapForm.controls.destination as UntypedFormControl;
  }

  get memo(): UntypedFormControl {
    return this.swapForm.controls.memo as UntypedFormControl;
  }

  get slippageTolerance(): UntypedFormControl {
    return this.swapForm.controls.slippageTolerance as UntypedFormControl;
  }

  get formPathType(): UntypedFormControl {
    return this.swapForm.controls.pathType as UntypedFormControl;
  }

  get pathTypeValue(): 'send' | 'receive' {
    return this.swapForm.controls.pathType.value;
  }

  get fromAssetAmount(): UntypedFormControl {
    return (this.swapForm.controls.fromAsset as UntypedFormGroup).controls
      .amount as UntypedFormControl;
  }

  get toAssetAmount(): UntypedFormControl {
    return (this.swapForm.controls.toAsset as UntypedFormGroup).controls
      .amount as UntypedFormControl;
  }

  get pathValue(): ServerApi.PaymentPathRecord | undefined {
    return this.swapForm.value.path;
  }

  get exchangeRate(): IExchangeRate {
    return this.swapForm.value.exchangeRate;
  }

  get continuousTransactionState(): UntypedFormControl {
    return this.swapForm.controls
      .continuousTransactionState as UntypedFormControl;
  }

  fundsAvailableToSend$: Observable<string> =
    this.swapForm.controls.fromAsset.valueChanges.pipe(
      switchMap((value: IAssetFormField) => {
        return this.selectedWalletAccount$.pipe(
          map((walletAccount) => {
            if (
              !walletAccount ||
              !walletAccount.accountRecord ||
              !value.asset
            ) {
              return '0';
            }
            const targetBalance = this.walletsAssetsService
              .filterBalancesLines(walletAccount.accountRecord.balances)
              .find((b) => {
                return (
                  value.asset._id ===
                  this.walletsAssetsService.formatBalanceLineId(b)
                );
              });

            if (!targetBalance) {
              return '0';
            }

            return this.stellarSdkService
              .calculateAvailableBalance({
                account: walletAccount.accountRecord,
                balanceLine: targetBalance,
              })
              .toFixed(7);
          })
        );
      })
    );

  constructor(
    private readonly walletsAssetsQuery: WalletsAssetsQuery,
    private readonly walletsAssetsService: WalletsAssetsService,
    private readonly walletAccountsQuery: WalletsAccountsQuery,
    private readonly nzMessageService: NzMessageService,
    private readonly stellarSdkService: StellarSdkService,
    private readonly nzDrawerService: NzDrawerService,
    private readonly walletsOffersService: WalletsOffersService,
    private readonly walletOffersQuery: WalletsOffersQuery,
    private readonly route: ActivatedRoute,
    private readonly translateService: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    private readonly walletsQuery: WalletsQuery,
    private readonly cryptoService: CryptoService,
    public viewContainerRef: ViewContainerRef
  ) {}

  updatePathFromHorizonSubscription: Subscription = combineLatest([
    this.swapForm.controls.fromAsset.valueChanges,
    this.swapForm.controls.toAsset.valueChanges,
  ])
    .pipe(debounceTime(1000))
    .pipe(takeUntil(this.componentDestroyed$))
    .subscribe(async (_) => {
      if (this.fromAssetAmount.valid && this.toAssetAmount.valid) {
        this.gettingPathPaymentRecord$.next(true);
        try {
          await this.updatePaymentPath();
        } catch (e) {}
        this.gettingPathPaymentRecord$.next(false);
      }
    });

  setStrictSendTypeSubscription: Subscription =
    this.fromAssetAmount.valueChanges
      .pipe(debounceTime(1000))
      .pipe(takeUntil(this.componentDestroyed$))
      .subscribe(async (_) => {
        if (this.formPathType.value === 'send') {
          this.swapRateDetails.fromAmount = this.fromAssetAmount.value;
          this.swapRateDetails.toAmount = 1;
        }
      });
  setStrictReceiveTypeSubscription: Subscription =
    this.toAssetAmount.valueChanges
      .pipe(debounceTime(1000))
      .pipe(takeUntil(this.componentDestroyed$))
      .subscribe(async (_) => {
        if (this.formPathType.value === 'receive') {
          this.swapRateDetails.fromAmount = 0;
          this.swapRateDetails.toAmount = this.toAssetAmount.value;
        }
      });

  // Final No Change
  setPathTypeSubscription: Subscription = this.formPathType.valueChanges
    .pipe(takeUntil(this.componentDestroyed$))
    .subscribe((_) => {
      this.toAssetAmount.removeValidators(this.toAssetValidator);
      this.fromAssetAmount.removeValidators(this.fromAssetValidator);
      if (_.toString().toUpperCase() === 'SEND') {
        this.toAssetAmount.addValidators(this.toAssetValidator);
      } else if (_.toString().toUpperCase() === 'RECEIVE') {
        this.fromAssetAmount.addValidators(this.fromAssetValidator);
      }
      this.swapRateDetails.fromAmount = 0;
      this.swapRateDetails.toAmount = this.toAssetAmount.value;
      this.fromAssetAmount.setValue('0');
      this.toAssetAmount.setValue('0');

      this.formPathType.setValue(_, { emitEvent: false });
    });

  swapAssetsSubscription: Subscription = this.swapAssets$
    .asObservable()
    .pipe(debounceTime(80))
    .pipe(takeUntil(this.componentDestroyed$))
    .subscribe(async (_) => {
      this.confirmingSwapAssets$.next(true);
      try {
        await this.confirmSwap();
      } catch (e) {}
      this.confirmingSwapAssets$.next(false);
    });

  ngOnInit(): void {
    this.continuousTransactionState.setValue(false);
  }

  ngAfterViewInit(): void {
    this.route.queryParams
      .pipe(take(1))
      // We use a small delay to avoid getting the template error because at the point we are setting this
      .pipe(delay(10))
      .subscribe((params) => {
        if (params.fromAssetId) {
          this.swapForm
            .get(['fromAsset', 'asset'])
            ?.patchValue(this.walletsAssetsQuery.getEntity(params.fromAssetId));
        }

        if (params.toAssetId) {
          this.swapForm
            .get(['toAsset', 'asset'])
            ?.patchValue(this.walletsAssetsQuery.getEntity(params.toAssetId));
        }
      });

    if (this.mode === 'payment') {
      this.swapForm.setControl(
        'destination',
        new UntypedFormControl('', [
          Validators.required,
          validPublicKeyValidator,
        ])
      );
    }
  }

  ngOnDestroy(): void {
    this.componentDestroyed$.next();
    this.componentDestroyed$.complete();
  }

  async searchAsset(formValue: 'from' | 'to'): Promise<void> {
    const myAssets = await this.myAssets$.pipe(take(1)).toPromise();

    this.nzDrawerService.create<AssetSearcherComponent>({
      nzContent: AssetSearcherComponent,
      nzPlacement: 'bottom',
      nzTitle: this.translateService.instant('SWAP.SELECT_ASSET_TITLE'),
      nzHeight: '100%',
      nzCloseOnNavigation: true,
      nzWrapClassName: 'ios-safe-y',
      nzContentParams: {
        defaultAssets: myAssets,
        assetSelectedFunc: (asset) => {
          if (formValue === 'from') {
            this.swapForm.get(['fromAsset', 'asset'])?.setValue(asset);
          }

          if (formValue === 'to') {
            this.swapForm.get(['toAsset', 'asset'])?.setValue(asset);
          }
        },
        disableCustomAsset: formValue === 'from',
        disableCuratedAssetByCreitTech: formValue === 'from',
      },
    });
  }

  checkValueIsInRange = (value: number) => {
    if (value >= this.swapRangeValues.min && value <= this.swapRangeValues.max)
      return true;
    else return false;
  };
  async updatePaymentPath(): Promise<void> {
    if (
      (this.swapForm.controls.fromAsset.invalid &&
        this.pathTypeValue === 'send') ||
      (this.swapForm.controls.toAsset.invalid &&
        this.pathTypeValue === 'receive')
    ) {
      return;
    }

    const fromAsset: IWalletAssetModel = this.swapForm.value.fromAsset.asset;
    const toAsset: IWalletAssetModel = this.swapForm.value.toAsset.asset;

    let response: { records: ServerApi.PaymentPathRecord[] };
    if (this.pathTypeValue === 'send') {
      response = await this.stellarSdkService
        .selectServer()
        .strictSendPaths(
          this.walletsAssetsService.sdkAssetFromAssetId(fromAsset._id),
          new BigNumber(this.fromAssetAmount.value).toFixed(7),
          [this.walletsAssetsService.sdkAssetFromAssetId(toAsset._id)]
        )
        .call()
        .catch((error) => {
          this.continuousTransactionState.setValue(false);
          console.error(error);
          return { records: [] };
        });
    } else if (this.pathTypeValue === 'receive') {
      response = await this.stellarSdkService
        .selectServer()
        .strictReceivePaths(
          [this.walletsAssetsService.sdkAssetFromAssetId(fromAsset._id)],
          this.walletsAssetsService.sdkAssetFromAssetId(toAsset._id),
          new BigNumber(this.toAssetAmount.value).toFixed(7)
        )
        .call()
        .catch((error) => {
          this.continuousTransactionState.setValue(false);
          console.error(error);
          return { records: [] };
        });
    } else {
      this.continuousTransactionState.setValue(false);
      console.warn('path type is not correct');
      return;
    }

    const cheapestPath = response.records.shift();

    if (!cheapestPath) {
      this.nzMessageService.error(
        this.translateService.instant('SWAP.NO_VALID_PATH')
      );
      this.continuousTransactionState.setValue(false);
      return;
    }

    this.swapForm.get('path')?.setValue(cheapestPath, { emitEvent: false });

    if (this.pathTypeValue === 'send') {
      const valueInFloat = Number.parseFloat(cheapestPath.destination_amount);
      this.swapRateDetails.toAmount = valueInFloat;
      if (!this.checkValueIsInRange(valueInFloat)) {
        this.continuousTransactionState.setErrors({ no_path_swap: true });
        this.nzMessageService.error('Receive amount out of selected range.');
      } else {
        this.continuousTransactionState.setErrors(null);
      }
    } else {
      const valueInFloat = Number.parseFloat(cheapestPath.source_amount);
      this.swapRateDetails.fromAmount = valueInFloat;
      if (!this.checkValueIsInRange(valueInFloat)) {
        this.continuousTransactionState.setErrors({ no_path_swap: true });
        this.nzMessageService.error('Send amount out of selected range.');
      } else {
        this.continuousTransactionState.setErrors(null);
      }
    }

    const exchangeRate: IExchangeRate = {
      numerator: fromAsset.assetCode,
      denominator: toAsset.assetCode,
      amount: this.calculateRate(),
    };
    this.swapForm.controls.exchangeRate.setValue(exchangeRate, {
      emitEvent: false,
    });
  }

  maxToSend(maxSendAmount?: string): string {
    let returnAmount = 0;
    if (maxSendAmount != '') {
      const sendAmount = maxSendAmount?.split('-');
      sendAmount?.reverse();
      let floatAmount;
      if (sendAmount?.length && sendAmount?.length > 0) {
        floatAmount = Number.parseFloat(sendAmount[0]);
      } else {
        floatAmount = Number.parseFloat(maxSendAmount ? maxSendAmount : '0');
      }
      returnAmount = Number.isNaN(floatAmount) ? 0 : floatAmount;
    } else {
      returnAmount = 0;
    }
    return new BigNumber(returnAmount)
      .multipliedBy(new BigNumber('1'))
      .toFixed(7);
  }

  minToReceive(minReceiveAmount?: string): string {
    let returnAmount = 0;
    if (minReceiveAmount != '') {
      const recivableAmount = minReceiveAmount?.split('-');
      let floatAmount;
      if (recivableAmount?.length && recivableAmount?.length > 0) {
        floatAmount = Number.parseFloat(recivableAmount[0]);
      } else {
        floatAmount = Number.parseFloat(
          minReceiveAmount ? minReceiveAmount : '0'
        );
      }
      returnAmount = Number.isNaN(floatAmount) ? 0 : floatAmount;
    } else {
      returnAmount = 0;
    }
    return new BigNumber(returnAmount)
      .multipliedBy(new BigNumber('1'))
      .toFixed(7);
  }

  calculateRate(): string {
    if (!new BigNumber(this.swapRateDetails.toAmount).isGreaterThan(0)) {
      return '0';
    }
    return new BigNumber(this.swapRateDetails.fromAmount)
      .dividedBy(this.swapRateDetails.toAmount)
      .toFixed(7);
  }

  async confirmSwap(): Promise<void> {
    const selectedAccount = await this.walletAccountsQuery.getSelectedAccount$
      .pipe(take(1))
      .toPromise();
    const updatedPath = this.pathValue;

    const fromAsset: IWalletAssetModel = this.swapForm.value.fromAsset.asset;
    const fromAssetClass =
      fromAsset._id === 'native'
        ? this.stellarSdkService.SDK.Asset.native()
        : new this.stellarSdkService.SDK.Asset(
            fromAsset.assetCode,
            fromAsset.assetIssuer
          );

    const toAsset: IWalletAssetModel = this.swapForm.value.toAsset.asset;
    const toAssetClass =
      toAsset._id === 'native'
        ? this.stellarSdkService.SDK.Asset.native()
        : new this.stellarSdkService.SDK.Asset(
            toAsset.assetCode,
            toAsset.assetIssuer
          );

    let loadedAccount: AccountResponse;
    try {
      loadedAccount = await this.stellarSdkService.loadAccount(
        selectedAccount.publicKey
      );
    } catch (e) {
      this.continuousTransactionState.setValue(false);
      this.nzMessageService.error(
        this.translateService.instant(
          'ERROR_MESSAGES.CANT_FETCH_ACCOUNT_FROM_HORIZON'
        )
      );

      return;
    }

    if (!updatedPath) {
      this.nzMessageService.error(
        this.translateService.instant('SWAP.NO_VALID_PATH')
      );
      this.continuousTransactionState.setValue(false);
      return;
    }

    const transactionBuilder =
      new this.stellarSdkService.SDK.TransactionBuilder(
        new this.stellarSdkService.SDK.Account(
          loadedAccount.accountId(),
          loadedAccount.sequence
        ),
        {
          fee: this.stellarSdkService.fee,
          networkPassphrase: this.stellarSdkService.networkPassphrase,
        }
      ).setTimeout(this.stellarSdkService.defaultTimeout);

    let hasTrustline = true;
    if (toAsset._id !== 'native') {
      hasTrustline = !!this.walletsAssetsService
        .filterBalancesLines(loadedAccount.balances)
        .find((b) => {
          return (
            b.asset_type !== 'native' &&
            b.asset_code === toAsset.assetCode &&
            b.asset_issuer === toAsset.assetIssuer
          );
        });
    }

    if (!hasTrustline && this.mode === 'swap') {
      transactionBuilder.addOperation(
        this.stellarSdkService.SDK.Operation.changeTrust({
          asset: toAssetClass,
        })
      );
    }

    const path = updatedPath.path.map((item) =>
      item.asset_type === 'native'
        ? this.stellarSdkService.SDK.Asset.native()
        : new this.stellarSdkService.SDK.Asset(
            item.asset_code,
            item.asset_issuer
          )
    );

    const destination =
      this.mode === 'payment'
        ? this.destination.value
        : loadedAccount.accountId();

    if (this.pathTypeValue === 'send') {
      transactionBuilder.addOperation(
        this.stellarSdkService.SDK.Operation.pathPaymentStrictSend({
          destination,
          destAsset: toAssetClass,
          sendAsset: fromAssetClass,
          destMin: this.minToReceive(this.toAssetAmount.value),
          sendAmount: new BigNumber(this.fromAssetAmount.value).toFixed(7),
          path,
        })
      );
    } else if (this.pathTypeValue === 'receive') {
      transactionBuilder.addOperation(
        this.stellarSdkService.SDK.Operation.pathPaymentStrictReceive({
          destination,
          destAsset: toAssetClass,
          sendAsset: fromAssetClass,
          destAmount: new BigNumber(this.toAssetAmount.value).toFixed(7),
          sendMax: this.maxToSend(this.fromAssetAmount.value),
          path,
        })
      );
    } else {
      this.nzMessageService.error(
        this.translateService.instant('SWAP.INCORRECT_SELECTION')
      );
      this.continuousTransactionState.setValue(false);
      return;
    }

    if (this.memo.value) {
      transactionBuilder.addMemo(
        this.stellarSdkService.SDK.Memo.text(this.memo.value)
      );
    }

    const formattedXDR = transactionBuilder.build().toXDR();
    const viewContainerRef = this.viewContainerRef;
    viewContainerRef.clear();
    const componentRef =
      viewContainerRef.createComponent<XdrSignerComponent>(XdrSignerComponent);
    componentRef.instance.xdr = formattedXDR;
    componentRef.instance.hideUI = true;
    componentRef.instance.errorHandler = () => {
      this.continuousTransactionState.setValue(false);
    };
    setTimeout(async () => {
      await componentRef.instance.onAccepted();
    }, 100);

    componentRef.instance.acceptHandler = async (signedXdr: any) => {
      try {
        await this.walletsOffersService.sendPathPayment(signedXdr);
        this.nzMessageService.success(
          this.translateService.instant('SUCCESS_MESSAGE.OPERATION_COMPLETED')
        );
        if (!this.swapForm.invalid && this.continuousTransactionState.value) {
          setTimeout(async () => {
            await this.updatePaymentPath();
            if (
              !this.swapForm.invalid &&
              this.continuousTransactionState.value
            ) {
              this.swapAssets$.next();
            } else {
              this.continuousTransactionState.setValue(false);
            }
          }, 1000);
        } else {
          this.continuousTransactionState.setValue(false);
        }
      } catch (e: any) {
        this.continuousTransactionState.setValue(false);
        this.nzMessageService.error(
          this.translateService.instant('ERROR_MESSAGES.NETWORK_REJECTED')
        );
      }
    };
  }

  scanPublicKey(): void {
    const drawerRef = this.nzDrawerService.create<QrScanModalComponent>({
      nzContent: QrScanModalComponent,
      nzPlacement: 'bottom',
      nzWrapClassName: 'drawer-full-w-340 ios-safe-y',
      nzTitle: this.translateService.instant(
        'WALLET.SEND_PAYMENT.SCAN_PUBLIC_KEY_TITLE'
      ),
      nzHeight: '100%',
      nzContentParams: {
        handleQrScanned: (text) => {
          this.swapForm.controls.destination.patchValue(text);
          drawerRef.close();
        },
      },
    });

    drawerRef.open();
  }

  scanMemoText(): void {
    const drawerRef = this.nzDrawerService.create<QrScanModalComponent>({
      nzContent: QrScanModalComponent,
      nzPlacement: 'bottom',
      nzWrapClassName: 'ios-safe-y',
      nzTitle: this.translateService.instant(
        'WALLET.SEND_PAYMENT.SCAN_MEMO_TITLE'
      ),
      nzHeight: '100%',
      nzContentParams: {
        handleQrScanned: (text) => {
          this.swapForm.controls.memo.patchValue(text);
          drawerRef.close();
          this.cdr.detectChanges();
        },
      },
    });

    drawerRef.open();
  }

  toggleSwitch(eventArgs: any) {
    if (eventArgs?.target.checked) {
      this.continuousTransactionState.setValue(true);
      this.swapAssets$.next();
    } else {
      this.continuousTransactionState.setValue(false);
    }
  }
  isNumberOrFraction($event: any) {
    const key = $event.key;
    let textValue = $event.target.value.toString();
    const regex = /^[0-9\-\.]*$/;
    if (regex.test(key)) {
      if (key === '-' && textValue.includes('-')) {
        return false;
      }
      return true;
    } else {
      return false;
    }
  }
}

interface IAssetFormField {
  amount: number;
  asset: IWalletAssetModel;
}

interface IExchangeRate {
  denominator: string;
  numerator: string;
  amount: string;
}
